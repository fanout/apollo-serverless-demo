import { PubSub, PubSubEngine } from "apollo-server";
import { Context, SubscriptionServerOptions } from "apollo-server-core";
import { ExpressContext } from "apollo-server-express/dist/ApolloServer";
import { filter } from "axax/es5/filter";
import { map } from "axax/es5/map";
import { pipe } from "axax/es5/pipe";
import "core-js/es/symbol/async-iterator";
import { GraphQLSchema } from "graphql";
import { withFilter } from "graphql-subscriptions";
import gql from "graphql-tag";
import { IResolvers, makeExecutableSchema } from "graphql-tools";
import { $$asyncIterator, createIterator } from "iterall";
import * as querystring from "querystring";
import * as uuidv4 from "uuid/v4";
import {
  IEpcpPublish,
  returnTypeNameForSubscriptionFieldName,
} from "./graphql-epcp-pubsub/EpcpPubSubMixin";
import {
  getQueryArgumentValue,
  interpolateValueNodeWithVariables,
} from "./graphql-ws/GraphqlQueryTools";
import { ISimpleTable } from "./SimpleTable";
import {
  getSubscriptionOperationFieldName,
  IGraphqlWsStartEventPayload,
  IGraphqlWsStartMessage,
  isGraphqlWsStartMessage,
} from "./subscriptions-transport-ws-over-http/GraphqlWebSocketOverHttpConnectionListener";

/** Common queries for this API */
export const FanoutGraphqlSubscriptionQueries = {
  noteAdded: `
    subscription {
      noteAdded {
        content,
        id,
      }
    }
  `,
};

enum SubscriptionEventNames {
  noteAdded = "noteAdded",
  noteAddedToChannel = "noteAddedToChannel",
}

export interface INote {
  /** unique identifier for the note */
  id: string;
  /** channel id that the note is in */
  channel: string;
  /** main body content of the Note */
  content: string;
}

export interface IGraphqlSubscription {
  /** unique identifier for the subscription */
  id: string;
  /** Provided by the subscribing client in graphql-ws 'GQL_START' message. Must be sent in each published 'GQL_DATA' message */
  operationId: string;
  /**
   * The GQL_START message that started the subscription. It includes the query and stuff.
   * https://github.com/apollographql/subscriptions-transport-ws/blob/master/PROTOCOL.md#gql_start
   */
  startMessage: string;
  /** The name of the field in the GraphQL Schema being subscribed to. i.e. what you probably think of as the subscription name */
  subscriptionFieldName: string;
}

export interface IFanoutGraphqlTables {
  /** Notes table */
  notes: ISimpleTable<INote>;
  /** Subscriptions - keep track of GraphQL Subscriptions */
  subscriptions: ISimpleTable<IGraphqlSubscription>;
}

interface IFanoutGraphqlAppContext {
  /** Authorization token, if present */
  authorization: string | undefined;
}

/**
 * Create a graphql typeDefs string for the FanoutGraphql App
 */
export const FanoutGraphqlTypeDefs = (subscriptions: boolean) => `
type Note {
  channel: String!
  content: String!
  id: String!
}
input NotesQueryInput {
  channel: String
}
type Query {
  notes: [Note!]!
  getNotesByChannel(channel: String!): [Note!]!
}
input AddNoteInput {
  "Channel to add note to"
  channel: String!
  "The main body content of the Note"
  content: String!
}
type Mutation {
  addNote(note: AddNoteInput!): Note
}
${
  subscriptions
    ? `
  type Subscription {
    noteAdded: Note
    noteAddedToChannel(channel: String!): Note
  }
  `
    : ""
}
`;

/**
 * given an object, return the same, ensuring that the object keys were inserted in alphabetical order
 * https://github.com/nodejs/node/issues/6594#issuecomment-217120402
 */
function sorted(o: any) {
  const p = Object.create(null);
  for (const k of Object.keys(o).sort()) {
    p[k] = o[k];
  }
  return p;
}

const gripChannelNames = {
  noteAdded(operationId: string) {
    return `${SubscriptionEventNames.noteAdded}?${querystring.stringify(
      sorted({
        "subscription.operation.id": operationId,
      }),
    )}`;
  },
  noteAddedToChannel(operationId: string, channel: string) {
    return `${
      SubscriptionEventNames.noteAddedToChannel
    }?${querystring.stringify(
      sorted({
        channel,
        "subscription.operation.id": operationId,
      }),
    )}`;
  },
};

/** Given a subscription operation, return the Grip channel name that should be subscribed to by that WebSocket client */
export const FanoutGraphqlGripChannelsForSubscription = (
  gqlStartMessage: IGraphqlWsStartMessage,
): string => {
  const subscriptionFieldName = getSubscriptionOperationFieldName(
    gqlStartMessage.payload,
  );
  switch (subscriptionFieldName) {
    case "noteAdded":
      return gripChannelNames.noteAdded(gqlStartMessage.id);
    case "noteAddedToChannel":
      const channel = interpolateValueNodeWithVariables(
        getQueryArgumentValue(gqlStartMessage.payload.query, "channel"),
        gqlStartMessage.payload.variables,
      );
      if (typeof channel !== "string") {
        throw new Error(
          `Expected channel argument value to be a string, but got ${channel}`,
        );
      }
      return gripChannelNames.noteAddedToChannel(gqlStartMessage.id, channel);
  }
  throw new Error(
    `FanoutGraphqlGripChannelsForSubscription got unexpected subscription field name: ${subscriptionFieldName}`,
  );
};

/** Return items in an ISimpleTable that match the provided filter function */
export const filterTable = async <ItemType extends object>(
  table: ISimpleTable<ItemType>,
  itemFilter: (item: ItemType) => boolean,
): Promise<ItemType[]> => {
  const filteredItems: ItemType[] = [];
  await table.scan(async items => {
    filteredItems.push(...items.filter(itemFilter));
    return true;
  });
  return filteredItems;
};

const SubscriptionIsNoteAddedToChannelFilter = (channelName: string) => (
  subscription: IGraphqlSubscription,
): boolean => {
  if (
    subscription.subscriptionFieldName !==
    SubscriptionEventNames.noteAddedToChannel
  ) {
    return false;
  }
  // it's a noteAddedToChannel subscription. Now to make sure it's for the right channel.
  const startMessage = JSON.parse(subscription.startMessage);
  if (!isGraphqlWsStartMessage(startMessage)) {
    console.warn(
      `Expected subscription.startMessage to match interface for IGraphqlWsStartMessage, but it didn't. Skipping. Message is ${
        subscription.startMessage
      }`,
    );
    return false;
  }
  const channelInQuery = interpolateValueNodeWithVariables(
    getQueryArgumentValue(startMessage.payload.query, "channel"),
    startMessage.payload.variables,
  );
  if (typeof channelInQuery !== "string") {
    throw new Error(
      `Expected channel argument value to be a string, but got ${channelInQuery}`,
    );
  }
  const channelMatchesFilter = channelInQuery === channelName;
  return channelMatchesFilter;
};

/** Array reducer that returns an array of the unique items of the reduced array */
function uniqueReducer<Item>(prev: Item[] | Item, curr: Item): Item[] {
  if (!Array.isArray(prev)) {
    prev = [prev];
  }
  if (prev.indexOf(curr) === -1) {
    prev.push(curr);
  }
  return prev;
}

interface INoteAddedPublish {
  /** trigger name is always noteAdded */
  triggerName: "noteAdded";
  /** publish payload */
  payload: {
    /** The note that was added */
    noteAdded: INote;
  };
}

interface IFanoutGraphqlEpcpPublishesForPubSubEnginePublishOptions {
  /** graphql schema */
  schema: GraphQLSchema;
  /** stored subscriptions so we can look up what subscriptions need to be published to */
  subscriptions: ISimpleTable<IGraphqlSubscription>;
}

/** Given arguments to PubSubEngine#publish, return an array of EPCP Publishes that should be sent to GRIP server */
export const FanoutGraphqlEpcpPublishesForPubSubEnginePublish = (
  options: IFanoutGraphqlEpcpPublishesForPubSubEnginePublishOptions,
) => async ({
  triggerName,
  payload,
}: INoteAddedPublish): Promise<IEpcpPublish[]> => {
  switch (triggerName) {
    case SubscriptionEventNames.noteAdded:
      const note = payload[SubscriptionEventNames.noteAdded];
      // Publish to 'noteAdded'.
      // The 'id' in the published message must correspond to the 'id' in a GQL_START event that started the subscription (according to graphql-ws protocol), otherwise e.g. ApolloClient may not route the message correctly.
      // So we're going to query the subscriptions table for 'noteAdded' subscriptions, then find the unique operation id values, then publish a payload for each unique operationId value.
      // @TODO make use of pushpin var-subst feature to only publish once here and have pushpin substitute in the operationId: https://github.com/fanout/pushpin/commit/1977142db7bc98ab7f651a8813a5940949caf612
      const subscriptionsForNoteAdded = await filterTable(
        options.subscriptions,
        (subscription: IGraphqlSubscription) =>
          subscription.subscriptionFieldName === "noteAdded",
      );
      const noteAddedPublishes = subscriptionsForNoteAdded
        .map(subscription => subscription.operationId)
        .reduce(uniqueReducer, [] as string[])
        .map(operationId => {
          const noteAddedPublish: IEpcpPublish = {
            channel: gripChannelNames.noteAdded(operationId),
            message: JSON.stringify({
              id: operationId,
              payload: {
                data: {
                  [SubscriptionEventNames.noteAdded]: {
                    __typename: returnTypeNameForSubscriptionFieldName(
                      options.schema,
                      SubscriptionEventNames.noteAdded,
                    ),
                    ...note,
                  },
                },
              },
              type: "data",
            }),
          };
          return noteAddedPublish;
        });

      // Publishes for 'noteAddedToChannel' subscriptions, which may have new data since there is a new noteAdded publish
      const subscriptionsForNoteAddedToThisChannel = await filterTable(
        options.subscriptions,
        SubscriptionIsNoteAddedToChannelFilter(note.channel),
      );
      const noteAddedToChannelPublishes = subscriptionsForNoteAddedToThisChannel
        .map(subscription => subscription.operationId)
        .reduce(uniqueReducer, [] as string[])
        .map(operationId => {
          // Message to publish to noteAddedToChannel subscriptions
          const noteAddedToChannelPublish: IEpcpPublish = {
            channel: gripChannelNames.noteAddedToChannel(
              operationId,
              note.channel,
            ),
            message: JSON.stringify({
              id: operationId,
              payload: {
                data: {
                  [SubscriptionEventNames.noteAddedToChannel]: {
                    __typename: returnTypeNameForSubscriptionFieldName(
                      options.schema,
                      SubscriptionEventNames.noteAddedToChannel,
                    ),
                    ...note,
                  },
                },
              },
              type: "data",
            }),
          };
          return noteAddedToChannelPublish;
        });

      return [...noteAddedPublishes, ...noteAddedToChannelPublishes];
  }
  return [];
};

interface IFanoutGraphqlApolloOptions {
  /** PubSubEngine to use to publish/subscribe mutations/subscriptions */
  pubsub?: PubSubEngine;
  /** Whether subscriptions are enabled in the schema */
  subscriptions: boolean;
  /** Tables to store data */
  tables: IFanoutGraphqlTables;
}

/**
 * ApolloServer.Config that will configure an ApolloServer to serve the FanoutGraphql graphql API.
 * @param pubsub - If not provided, subscriptions will not be enabled
 */
export const FanoutGraphqlApolloConfig = (
  options: IFanoutGraphqlApolloOptions,
) => {
  if (!options.subscriptions) {
    console.debug("FanoutGraphqlApolloConfig: subscriptions will be disabled.");
  }
  const { tables } = options;
  const pubsub = options.pubsub || new PubSub();

  // Construct a schema, using GraphQL schema language
  const typeDefs = FanoutGraphqlTypeDefs(options.subscriptions);
  interface INoteAddedEvent {
    /** Event payload */
    noteAdded: INote;
  }
  interface INoteAddedToChannelEvent {
    /** Event payload */
    noteAddedToChannel: INote;
  }
  const isNoteAddedEvent = (o: any): o is INoteAddedEvent => "noteAdded" in o;
  type SubscriptionEvent = INoteAddedEvent;
  // Provide resolver functions for your schema fields
  const resolvers: IResolvers = {
    Mutation: {
      async addNote(root, args) {
        const { note } = args;
        const noteId = uuidv4();
        const noteToInsert: INote = {
          ...note,
          id: noteId,
        };
        await options.tables.notes.insert(noteToInsert);
        if (pubsub) {
          await pubsub.publish(SubscriptionEventNames.noteAdded, {
            noteAdded: noteToInsert,
          });
        }
        return noteToInsert;
      },
    },
    Query: {
      getNotesByChannel: async (obj, args, context, info): Promise<INote[]> => {
        const notes: INote[] = [];
        await tables.notes.scan(async notesBatch => {
          notes.push(
            ...notesBatch.filter(note => note.channel === args.channel),
          );
          return true;
        });
        return notes;
      },
      notes: async (obj, args, context, info): Promise<INote[]> => {
        const notes = await tables.notes.scan();
        return notes;
      },
    },
    ...(options.subscriptions
      ? {
          Subscription: {
            noteAdded: {
              subscribe(
                source,
                args,
                context,
                info,
              ): AsyncIterator<INoteAddedEvent> {
                const noteAddedEvents = withFilter(
                  () =>
                    pubsub.asyncIterator<unknown>([
                      SubscriptionEventNames.noteAdded,
                    ]),
                  (payload, variables) => {
                    return isNoteAddedEvent(payload);
                  },
                )(source, args, context, info);
                return noteAddedEvents;
              },
            },
            noteAddedToChannel: {
              subscribe(source, args, context, info) {
                const eventFilter = (event: object) =>
                  isNoteAddedEvent(event) &&
                  event.noteAdded.channel === args.channel;
                const noteAddedIterator = pubsub.asyncIterator([
                  SubscriptionEventNames.noteAdded,
                ]);
                const iterable = {
                  [Symbol.asyncIterator]() {
                    return noteAddedIterator;
                  },
                };
                const notesAddedToChannel = pipe(
                  filter(eventFilter),
                  map(event => {
                    return {
                      noteAddedToChannel: event.noteAdded,
                    };
                  }),
                )(iterable);
                // Have to use this $$asyncIterator from iterall so that graphql/subscription will recognize this as an AsyncIterable
                // even when compiled for node version 8, which doesn't have Symbol.asyncIterator
                return {
                  [$$asyncIterator]() {
                    return notesAddedToChannel[Symbol.asyncIterator]();
                  },
                };
              },
            },
          },
        }
      : {}),
  };

  const subscriptions: Partial<SubscriptionServerOptions> = {
    path: "/",
    onConnect(connectionParams, websocket, context) {
      console.log("FanoutGraphqlApolloConfig subscription onConnect");
    },
    onDisconnect() {
      console.log("FanoutGraphqlApolloConfig subscription onDisconnect");
    },
  };

  interface ISubscriptionContextOptions {
    /** graphql context to use for subscription */
    context: Context;
  }

  const createContext = async (
    contextOptions: ExpressContext | ISubscriptionContextOptions,
  ): Promise<IFanoutGraphqlAppContext> => {
    // console.log("FanoutGraphqlApolloConfig createContext with contextOptions");
    const connectionContext =
      "context" in contextOptions ? contextOptions.context : {};
    const contextFromExpress =
      "req" in contextOptions
        ? { authorization: contextOptions.req.headers.authorization }
        : {};
    const context: IFanoutGraphqlAppContext = {
      authorization: undefined,
      ...connectionContext,
      ...contextFromExpress,
    };
    return context;
  };

  // const DebugApolloServerPlugin = (): ApolloServerPlugin => ({
  //   requestDidStart(requestContext) {
  //     console.log("requestDidStart");
  //   },
  // });

  const schema = makeExecutableSchema({ typeDefs, resolvers });
  return {
    context: createContext,
    plugins: [
      // DebugApolloServerPlugin(),
    ],
    schema,
    subscriptions: pubsub && subscriptions,
  };
};

export default FanoutGraphqlApolloConfig;
