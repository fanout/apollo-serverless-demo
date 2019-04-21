import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import { ApolloServer, gql } from "apollo-server-lambda";
import { APIGatewayProxyEvent } from "aws-lambda";
import { APIGateway } from "aws-sdk";
import { compose, identity } from "fp-ts/lib/function";
import ApolloLambdaContextFromPulumiContext from "./ApolloLambdaContextFromPulumiContext";
import FanoutGraphqlApolloConfig from "./FanoutGraphqlApolloConfig";

type APIGatewayEventMiddleware = (
  event: APIGatewayProxyEvent,
) => APIGatewayProxyEvent;

// Will serve graphiql playground. But it has a bug when served at /stage/ on lambda.
// So in that case, we'll need to patch the event.
// via: https://github.com/apollographql/apollo-server/pull/2241#issuecomment-460889307
const playgroundLambdaStageMiddleware: APIGatewayEventMiddleware = (
  event: APIGatewayProxyEvent,
): APIGatewayProxyEvent => {
  const isGetGraphiqlPlayground = event.httpMethod === "GET";
  if (isGetGraphiqlPlayground) {
    return { ...event, path: event.requestContext.path || event.path };
  }
  // Don't modify event
  return event;
};

/**
 * APIGatewayEventMiddleware that will rewrite events that have base64encoded bodies to not have them.
 * This is useful because apollo-server-lambda doesn't expect to get base64 encoded bodies. It just tries to JSON.parse(event.body).
 * Which throws an error and breaks things.
 */
const base64DecodeBodyMiddleware: APIGatewayEventMiddleware = event => {
  if (!(event.isBase64Encoded && event.body)) {
    return event;
  }
  return {
    ...event,
    body: Buffer.from(event.body, "base64").toString(),
    isBase64Encoded: false,
  };
};

/**
 * Create a function that can be used as an AWS Lambda Callback.
 * The function has the functionality of serving a GraphQL API configured by FanoutGraphqlApp.
 */
const FanoutGraphqlAppLambdaCallback = (): aws.lambda.Callback<
  awsx.apigateway.Request,
  awsx.apigateway.Response
> => {
  // Use the ApolloServer handler, but allow passing pulumi's type for Context
  const handler: aws.lambda.EventHandler<
    awsx.apigateway.Request,
    awsx.apigateway.Response
  > = (event, context, callback) => {
    console.log("FanoutGraphqlAppLambdaCallback initial event", event);
    const server = new ApolloServer({
      ...FanoutGraphqlApolloConfig(),
    });
    const apolloHandler = server.createHandler();
    apolloHandler(
      compose(
        playgroundLambdaStageMiddleware,
        base64DecodeBodyMiddleware,
      )(event),
      ApolloLambdaContextFromPulumiContext(context),
      callback,
    );
  };
  return handler;
};

export default FanoutGraphqlAppLambdaCallback;
