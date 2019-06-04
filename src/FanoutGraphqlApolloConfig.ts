import { PubSub, PubSubEngine } from "apollo-server";
import { Context, SubscriptionServerOptions } from "apollo-server-core";
import { ExpressContext } from "apollo-server-express/dist/ApolloServer";
import { filter } from "axax/es5/filter";
import { map } from "axax/es5/map";
import { pipe } from "axax/es5/pipe";
import "core-js/es/symbol/async-iterator";
import { GraphQLSchema } from "graphql";
import { withFilter } from "graphql-subscriptions";
import { IResolvers, makeExecutableSchema } from "graphql-tools";
import { $$asyncIterator, createIterator } from "iterall";
import * as querystring from "querystring";
import * as uuidv4 from "uuid/v4";
import {
  IEpcpPublish,
  returnTypeNameForSubscriptionFieldName,
} from "./graphql-epcp-pubsub/EpcpPubSubMixin";
import { ISimpleTable } from "./SimpleTable";
import {
  getSubscriptionOperationFieldName,
  IGraphqlWsStartEventPayload,
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

export interface IFanoutGraphqlTables {
  /** Notes table */
  notes: ISimpleTable<INote>;
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

/** Create the Grip-Channel name string for a noteAddedToChannel publish with channel argument */
const noteAddedToChannelChannelName = (channel: string): string => {
  return `${SubscriptionEventNames.noteAddedToChannel}?${querystring.stringify({
    channel,
  })}`;
};

/** Given a subscription operation, return the Grip channel name that should be subscribed to by that WebSocket client */
export const FanoutGraphqlGripChannelsForSubscription = (
  subscriptionOperation: IGraphqlWsStartEventPayload,
): string => {
  const subscriptionFieldName = getSubscriptionOperationFieldName(
    subscriptionOperation,
  );
  switch (subscriptionFieldName) {
    case "noteAddedToChannel":
      // Add 'channel' query argument to Grip-Channel name
      // TODO: the keys of .variables may not always be predictable, since they can be query-author-defined regardless of schema. May need to introspect the parsed query to see how the user-defined variable names map to the actual GraphQL Schema
      return `${subscriptionFieldName}?${querystring.stringify({
        channel: subscriptionOperation.variables.channel,
      })}`;
  }
  return subscriptionFieldName;
};

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
}

/** Given arguments to PubSubEngine#publish, return an array of EPCP Publishes that should be sent to GRIP server */
export const FanoutGraphqlEpcpPublishesForPubSubEnginePublish = (
  options: IFanoutGraphqlEpcpPublishesForPubSubEnginePublishOptions,
) => ({ triggerName, payload }: INoteAddedPublish): IEpcpPublish[] => {
  switch (triggerName) {
    case SubscriptionEventNames.noteAdded:
      const note = payload[SubscriptionEventNames.noteAdded];
      // Publish to 'noteAdded' and also a noteAddedToChannel
      const noteAddedPublish: IEpcpPublish = {
        channel: SubscriptionEventNames.noteAdded,
        message: JSON.stringify({
          id: "1", // TODO: this should be based on the subscription's graphqlWsEvent.id
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
      // Message to publish to noteAddedToChannel subscriptions
      const noteAddedToChannelPublish: IEpcpPublish = {
        channel: noteAddedToChannelChannelName(note.channel),
        message: JSON.stringify({
          id: "2", // TODO: this should be based on the subscription's graphqlWsEvent.id
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
      return [noteAddedPublish, noteAddedToChannelPublish];
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
                console.log("in Subscription.noteAdded");
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
