import * as pulumiAws from "@pulumi/aws";
import * as pulumiAwsx from "@pulumi/awsx";
import { AsyncTest, Expect, TestFixture } from "alsatian";
import { APIGatewayProxyEvent, Handler } from "aws-lambda";
import {
  decodeWebSocketEvents,
  encodeWebSocketEvents,
  WebSocketEvent,
} from "grip";
import * as LambdaTester from "lambda-tester";
import { INote } from "./FanoutGraphqlApolloConfig";
import FanoutGraphqlAppLambdaCallback from "./FanoutGraphqlAppLambdaCallback";
import { MapSimpleTable } from "./SimpleTable";
import { cli } from "./test/cli";

/** Convert a pulumi aws.lambda.Callback to a handler function that can be used with lambda-tester. The types are slightly different */
const PulumiCallbackForLambdaTester = (
  pulumiCallback: pulumiAws.lambda.Callback<
    pulumiAwsx.apigateway.Request,
    pulumiAwsx.apigateway.Response
  >,
): Handler => {
  return (event, context, callback) => {
    const contextForLambdaTester: pulumiAws.lambda.Context = {
      ...context,
      clientContext: context.clientContext || {},
      getRemainingTimeInMillis: () =>
        String(context.getRemainingTimeInMillis()),
      identity: context.identity || {},
      memoryLimitInMB: String(context.memoryLimitInMB),
    };
    const promiseResponse = pulumiCallback(
      event,
      contextForLambdaTester,
      callback,
    );
    if (promiseResponse) {
      promiseResponse
        .then(response => callback(null, response))
        .catch(callback);
    }
  };
};

/** Given object, return the same with all  lowercased */
const lowerCaseKeys = (headers: object) => {
  const headersWithLowerCaseKeys: { [key: string]: string } = {};
  for (const [header, value] of Object.entries(headers)) {
    headersWithLowerCaseKeys[header.toLowerCase()] = value;
  }
  return headersWithLowerCaseKeys;
};

/** Test Suite for FanoutGraphqlAppLambdaCallback */
@TestFixture()
export class FanoutGraphqlAppLambdaCallbackTest {
  /**
   * Test FanoutGraphqlExpressServer with defaults
   */
  @AsyncTest()
  public async testFanoutGraphqlAppLambdaCallbackForGraphiqlPlayground(
    pushpinGripUrl = process.env.GRIP_URL || "http://localhost:5561",
  ) {
    const handler = FanoutGraphqlAppLambdaCallback({
      grip: {
        url: pushpinGripUrl,
      },
      tables: { notes: MapSimpleTable<INote>() },
    });
    const event: Partial<APIGatewayProxyEvent> = {
      headers: {
        Accept: "text/html, application/json",
      },
      httpMethod: "GET",
      path: "/",
    };
    Expect(typeof handler).toBe("function");
    await LambdaTester(PulumiCallbackForLambdaTester(handler))
      .event(event)
      .expectResult(result => {
        // should be graphiql playground
        Expect(result).toBeTruthy();
        Expect(result.statusCode).toBe(200);
        Expect(typeof result.headers).toBe("object");
        const headers = lowerCaseKeys(result.headers);
        Expect(headers["content-type"]).toBe("text/html");
      });
  }
  /**
   * Test that FanoutGraphqlAppLambdaCallback will handle WebSocket-Over-HTTP requests
   */
  @AsyncTest()
  public async testFanoutGraphqlAppLambdaCallbackForWebSocketOverHttp(
    pushpinGripUrl = process.env.GRIP_URL || "http://localhost:5561",
  ) {
    const handler = FanoutGraphqlAppLambdaCallback({
      grip: {
        url: pushpinGripUrl,
      },
      tables: { notes: MapSimpleTable<INote>() },
    });
    const wsOverHttpHeaders = {
      "connection-id": "testFanoutGraphqlAppLambdaCallbackForWebSocketOverHttp",
      "content-type": "application/websocket-events",
      "grip-sig": "foo",
    };
    const wsOverHttpEvent: Partial<APIGatewayProxyEvent> = {
      headers: wsOverHttpHeaders,
      httpMethod: "POST",
      path: "/",
    };
    const graphqlWsOverHttpEvent: Partial<APIGatewayProxyEvent> = {
      ...wsOverHttpEvent,
      headers: {
        ...wsOverHttpEvent.headers,
        "sec-websocket-protocol": "graphql-ws",
      },
    };
    const openEvent: Partial<APIGatewayProxyEvent> = {
      ...graphqlWsOverHttpEvent,
      body: "OPEN\r\n",
    };
    Expect(typeof handler).toBe("function");
    await LambdaTester(PulumiCallbackForLambdaTester(handler))
      .event(openEvent)
      .expectResult(result => {
        // should be graphiql playground
        Expect(result).toBeTruthy();
        Expect(result.statusCode).toBe(200);
        Expect(result.body).toEqual("OPEN\r\n");
        Expect(typeof result.headers).toBe("object");
        const headers = lowerCaseKeys(result.headers);
        Expect(headers["content-type"]).toBe("application/websocket-events");
        Expect(headers["sec-websocket-extensions"]).toEqual(
          'grip; message-prefix=""',
        );
        Expect(headers["sec-websocket-protocol"]).toEqual("graphql-ws");
      });

    // WebSocket-Over-HTTP Opened. Let's try sending graphql-ws messages
    const startGraphqlWsEvent: Partial<APIGatewayProxyEvent> = {
      ...graphqlWsOverHttpEvent,
      body: encodeWebSocketEvents([
        new WebSocketEvent("TEXT", JSON.stringify({ type: "connection_init" })),
      ]),
    };
    await LambdaTester(PulumiCallbackForLambdaTester(handler))
      .event(startGraphqlWsEvent)
      .expectResult(result => {
        // should be graphiql playground
        Expect(result).toBeTruthy();
        Expect(result.statusCode).toBe(200);
        const websocketEvents = decodeWebSocketEvents(result.body);
        Expect(websocketEvents.length).toBeGreaterThan(0);
        const firstEventContent = websocketEvents[0].getContent();
        if (!firstEventContent) {
          throw new Error("first WebSocketEvent content should not be null");
        }
        const firstEventObject = JSON.parse(firstEventContent.toString());
        Expect(firstEventObject.type).toEqual("connection_ack");
      });
  }
}

if (require.main === module) {
  cli(__filename).catch((error: Error) => {
    throw error;
  });
}
