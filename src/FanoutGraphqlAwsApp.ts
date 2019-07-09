import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as cloud from "@pulumi/cloud";
import { PubSubEngine } from "apollo-server";
import { GraphqlWsOverWebSocketOverHttpStorageCleaner } from "fanout-graphql-tools";
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
  const webSocketOverHttpStorage = {
    connections: new cloud.Table(`${name}-connections`),
    pubSubSubscriptions: new cloud.Table(`${name}-pubSubSubscriptions`),
    subscriptions: new cloud.Table(`${name}-subscriptions`),
  };

  // AWS Resources for serving GraphQL API over HTTP
  const httpLambdaFunction = new aws.lambda.CallbackFunction(
    `${name}-fn-graphql`,
    {
      callback: FanoutGraphqlAppLambdaCallback({
        grip: options.grip,
        pubsub: options.pubsub,
        tables: {
          notes: new cloud.Table(`${name}-notes`),
          ...webSocketOverHttpStorage,
        },
      }),
      timeout: 30,
    },
  );
  const routes: awsx.apigateway.Route[] = [
    {
      eventHandler: httpLambdaFunction,
      method: "GET",
      path: "/",
    },
    {
      eventHandler: httpLambdaFunction,
      method: "POST",
      path: "/",
    },
  ];

  // AWS Resources required for periodic storage cleanup.
  /** Lambda that should be invoked periodically to clean up expired connections/subscriptions from DynamoDB */
  const cleanupStorageLambdaFunction = new aws.lambda.CallbackFunction(
    `${name}-storageCleaner`,
    {
      callback: async (event, context) => {
        console.log("Begin storage cleanup lambda callback", new Date(), {
          context,
          event,
        });
        const clean = GraphqlWsOverWebSocketOverHttpStorageCleaner({
          connectionStorage: webSocketOverHttpStorage.connections,
          pubSubSubscriptionStorage:
            webSocketOverHttpStorage.pubSubSubscriptions,
        });
        await clean();
        console.log("End storage cleanup lambda callback");
        return;
      },
    },
  );
  /** EventRule that produces events on a regular interval that will trigger the cleanupStorageLambdaFunction */
  const storageCleanupSchedulerEventRule = new aws.cloudwatch.EventRule(
    `${name}-storageCleanupScheduler`,
    {
      description: "Every 1 minute",
      // https://docs.aws.amazon.com/AmazonCloudWatch/latest/events/ScheduledEvents.html
      scheduleExpression: "rate(1 minute)",
    },
  );
  const storageCleanupEventSubscription = new aws.cloudwatch.EventRuleEventSubscription(
    `${name}-storageCleanup-es`,
    storageCleanupSchedulerEventRule,
    cleanupStorageLambdaFunction,
    {},
  );

  return { routes };
};

export default FanoutGraphqlAwsApp;
