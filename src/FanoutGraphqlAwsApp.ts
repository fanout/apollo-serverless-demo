import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as cloud from "@pulumi/cloud";
import { PubSubEngine } from "apollo-server";
import FanoutGraphqlAppLambdaCallback from "./FanoutGraphqlAppLambdaCallback";
import { IFanoutGraphqlServerGripOptions } from "./FanoutGraphqlExpressServer";

interface IFanoutGraphqlAwsAppOptions {
  /** configure grip or disable it */
  grip: false | IFanoutGraphqlServerGripOptions;
  /** PubSubEngine to use for GraphQL Subscriptions */
  pubsub?: PubSubEngine;
}

const FanoutGraphqlAwsApp = (
  name: string,
  options: IFanoutGraphqlAwsAppOptions,
) => {
  const lambdaFunction = new aws.lambda.CallbackFunction(`${name}-fn-graphql`, {
    callback: FanoutGraphqlAppLambdaCallback({
      grip: options.grip,
      pubsub: options.pubsub,
      tables: {
        connections: new cloud.Table(`${name}-connections`),
        notes: new cloud.Table(`${name}-notes`),
        subscriptions: new cloud.Table(`${name}-subscriptions`),
      },
    }),
    timeout: 30,
  });
  const routes: awsx.apigateway.Route[] = [
    {
      eventHandler: lambdaFunction,
      method: "GET",
      path: "/",
    },
    {
      eventHandler: lambdaFunction,
      method: "POST",
      path: "/",
    },
  ];
  return { routes };
};

export default FanoutGraphqlAwsApp;
