import { PubSubEngine } from "apollo-server";
import { GraphQLSchema } from "graphql";
import * as grip from "grip";
import * as pubcontrol from "pubcontrol";

export interface IPubSubEnginePublish {
  /** publish trigger name as string */
  triggerName: string;
  /** payload passed for this triggered publish */
  payload: any;
}

export interface IEpcpPublish {
  /** channel to publish to via EPCP */
  channel: string;
  /** message to send over channel */
  message: string;
}

/** Get the return type name of a subscription field */
export const returnTypeNameForSubscriptionFieldName = (
  schema: GraphQLSchema,
  fieldName: string,
): string => {
  const subscriptionType = schema.getSubscriptionType();
  if (!subscriptionType) {
    throw new Error("Could not get subscriptionType from GraphQLSchema");
  }
  const fieldForFieldName = subscriptionType.getFields()[fieldName];
  if (!fieldForFieldName) {
    throw new Error(
      `Could not find subscription type field for field name ${fieldName}`,
    );
  }
  const fieldReturnTypeName = (() => {
    const fieldType = fieldForFieldName.type;
    if ("name" in fieldType) {
      return fieldType.name;
    }
    if ("ofType" in fieldType) {
      // e.g. a NotNullType
      return fieldType.ofType.name;
    }
    assertNever(fieldType);
  })();
  return fieldReturnTypeName;
};

interface IEpcpPubSubMixinOptions {
  /** grip options */
  grip: {
    /** Grip Control URL */
    url: string;
  };
  /** GraphQL Schema */
  schema: GraphQLSchema;
  /** Given a PubSubEngine publish invocation, return instructions for what to publish to a GRIP server via EPCP */
  epcpPublishForPubSubEnginePublish(
    publish: IPubSubEnginePublish,
  ): IEpcpPublish[];
}

/**
 * Create a graphql PubSubEngine that wraps another one, but also publishes via EPCP to a GRIP server
 */
export default (options: IEpcpPubSubMixinOptions) => (
  pubsub: PubSubEngine,
): PubSubEngine => {
  const subscriptionType = options.schema.getSubscriptionType();
  if (!subscriptionType) {
    throw new Error(
      "Failed to build subscriptionType, but it is required for EpcpPubSub to work",
    );
  }
  const gripPubControl = new grip.GripPubControl(
    grip.parseGripUri(options.grip.url),
  );
  return {
    asyncIterator: pubsub.asyncIterator,
    subscribe: pubsub.subscribe,
    unsubscribe: pubsub.unsubscribe,
    async publish(triggerName: string, payload: any) {
      await pubsub.publish(triggerName, payload);
      const epcpPublishes = options.epcpPublishForPubSubEnginePublish({
        payload,
        triggerName,
      });
      await Promise.all(
        epcpPublishes.map(async epcpPublish => {
          return await new Promise((resolve, reject) => {
            gripPubControl.publish(
              epcpPublish.channel,
              new pubcontrol.Item(
                new grip.WebSocketMessageFormat(epcpPublish.message),
              ),
              (success, error, context) => {
                console.log(
                  `gripPubControl callback channel=${
                    epcpPublish.channel
                  } success=${success} error=${error} context=${context} message=${
                    epcpPublish.message
                  }`,
                );
                if (success) {
                  return resolve(context);
                }
                return reject(error);
              },
            );
          });
        }),
      );
    },
  };
};

/** TypeScript helper for exhaustive switches https://www.typescriptlang.org/docs/handbook/advanced-types.html  */
function assertNever(x: never): never {
  throw new Error("Unexpected object: " + x);
}
