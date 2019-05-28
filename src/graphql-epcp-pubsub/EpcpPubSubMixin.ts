import { PubSubEngine } from "apollo-server";
import { GraphQLSchema } from "graphql";
import * as grip from "grip";
import * as pubcontrol from "pubcontrol";

interface IEpcpPubSubMixinOptions {
  /** grip options */
  grip: {
    /** Grip Control URL */
    url: string;
  };
  /** GraphQL Schema */
  schema: GraphQLSchema;
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
  const createGraphqlWsMessageForPublish = (
    triggerName: string,
    payload: any,
  ) => {
    const fieldForTrigger = subscriptionType.getFields()[triggerName];
    if (fieldForTrigger) {
      const fieldReturnTypeName = (() => {
        const fieldType = fieldForTrigger.type;
        if ("name" in fieldType) {
          return fieldType.name;
        }
        if ("ofType" in fieldType) {
          // e.g. a NotNullType
          return fieldType.ofType.name;
        }
        assertNever(fieldType);
      })();
      return JSON.stringify({
        id: "1", // TODO: this should be based on the subscription's graphqlWsEvent.id
        payload: {
          data: {
            [triggerName]: {
              __typename: fieldReturnTypeName,
              ...payload[triggerName],
            },
          },
        },
        type: "data",
      });
    } else {
      console.log(
        `createGraphqlWsMessageForPublish unexpected triggerName: ${triggerName}`,
      );
    }
    return;
  };
  return {
    asyncIterator: pubsub.asyncIterator,
    subscribe: pubsub.subscribe,
    unsubscribe: pubsub.unsubscribe,
    async publish(triggerName: string, payload: any) {
      await pubsub.publish(triggerName, payload);
      const graphqlWsMessage = createGraphqlWsMessageForPublish(
        triggerName,
        payload,
      );
      if (graphqlWsMessage) {
        await new Promise((resolve, reject) => {
          gripPubControl.publish(
            triggerName,
            new pubcontrol.Item(
              new grip.WebSocketMessageFormat(graphqlWsMessage),
            ),
            (success, error, context) => {
              console.log(
                `gripPubControl callback success=${success} error=${error} context=${context}`,
              );
              if (success) {
                return resolve(context);
              }
              return reject(error);
            },
          );
        });
      }
    },
  };
};

/** TypeScript helper for exhaustive switches https://www.typescriptlang.org/docs/handbook/advanced-types.html  */
function assertNever(x: never): never {
  throw new Error("Unexpected object: " + x);
}
