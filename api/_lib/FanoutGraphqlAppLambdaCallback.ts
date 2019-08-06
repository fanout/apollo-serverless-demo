import aws from "@pulumi/aws";
import awsx from "@pulumi/awsx";
import { PubSubEngine } from "apollo-server";
import { APIGatewayProxyEvent } from "aws-lambda";
import AWSLambda from "aws-lambda";
import awsServerlessExpress from "aws-serverless-express";
import { compose } from "fp-ts/lib/function";
import { IFanoutGraphqlTables } from "./FanoutGraphqlApolloConfig";
import {
  FanoutGraphqlExpressServer,
  IFanoutGraphqlServerGripOptions,
} from "./FanoutGraphqlExpressServer";

/**
 * The types of Pulumi's Lambda Context and that of the apollo-graphql-lambda EventHandler are very slightly different.
 * This converts from the former to the latter.
 */
const AwsLambdaContextForPulumiContext = (
  pulumiContext: aws.lambda.Context,
): AWSLambda.Context => {
  const lambdaContext: AWSLambda.Context = {
    done() {
      throw new Error("done is just a placeholder ");
    },
    fail() {
      throw new Error("fail is just a placeholder ");
    },
    succeed() {
      throw new Error("succeed is just a placeholder ");
    },
    ...pulumiContext,
    getRemainingTimeInMillis: () =>
      parseInt(pulumiContext.getRemainingTimeInMillis(), 10),
    memoryLimitInMB: parseInt(pulumiContext.memoryLimitInMB, 10),
  };
  return lambdaContext;
};

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
    return {
      ...event,
      path: (event.requestContext && event.requestContext.path) || event.path,
    };
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

interface IFanoutGraphqlAppLambdaCallbackOptions {
  /** Configure grip */
  grip: false | IFanoutGraphqlServerGripOptions;
  /** Base PubSubEngine to use for GraphQL Subscriptions */
  pubsub?: PubSubEngine;
  /** objects that store data for the app */
  tables: IFanoutGraphqlTables;
}

/**
 * Create a function that can be used as an AWS Lambda Callback.
 * The function has the functionality of serving a GraphQL API configured by FanoutGraphqlApp.
 */
const FanoutGraphqlAppLambdaCallback = (
  options: IFanoutGraphqlAppLambdaCallbackOptions,
): aws.lambda.Callback<awsx.apigateway.Request, awsx.apigateway.Response> => {
  const lambdaEventMiddleware = compose(
    playgroundLambdaStageMiddleware,
    base64DecodeBodyMiddleware,
  );
  const handler: aws.lambda.EventHandler<
    awsx.apigateway.Request,
    awsx.apigateway.Response
  > = async (event, context) => {
    console.log("FanoutGraphqlAppLambdaCallback start", {
      context,
      event,
    });
    const fanoutGraphqlExpressServer = FanoutGraphqlExpressServer(options);
    const response = await awsServerlessExpress.proxy(
      awsServerlessExpress.createServer(
        fanoutGraphqlExpressServer.requestListener,
      ),
      lambdaEventMiddleware(event),
      AwsLambdaContextForPulumiContext(context),
      "PROMISE",
    ).promise;
    console.log("FanoutGraphqlAppLambdaCallback response", response);
    return response;
  };
  return handler;
};

export default FanoutGraphqlAppLambdaCallback;
