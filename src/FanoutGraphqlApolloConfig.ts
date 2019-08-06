import { PubSub, PubSubEngine } from "apollo-server";
import { Context, SubscriptionServerOptions } from "apollo-server-core";
import { ExpressContext } from "apollo-server-express/dist/ApolloServer";
import { filter } from "axax/es5/filter";
import { map } from "axax/es5/map";
import { pipe } from "axax/es5/pipe";
import "core-js/es/symbol/async-iterator";
import {
  getQueryArgumentValue,
  interpolateValueNodeWithVariables,
  IStoredConnection,
} from "fanout-graphql-tools";
import { ISimpleTable } from "fanout-graphql-tools";
import {
  getSubscriptionOperationFieldName,
  IGraphqlWsStartMessage,
} from "fanout-graphql-tools";
import { WebSocketOverHttpContextFunction } from "fanout-graphql-tools";
import { IStoredPubSubSubscription } from "fanout-graphql-tools";
import { WebSocketOverHttpPubSubMixin } from "fanout-graphql-tools";
import { withFilter } from "graphql-subscriptions";
import gql from "graphql-tag";
import { IResolvers, makeExecutableSchema } from "graphql-tools";
import { $$asyncIterator } from "iterall";
import querystring from "querystring";
import uuidv4 from "uuid/v4";

/** Common queries for this API */
export const FanoutGraphqlSubscriptionQueries = {
  noteAdded() {
    return {
      query: gql`
        subscription {
          noteAdded {
            content
            id
          }
        }
      `,
      variables: {},
    };
  },
  noteAddedToCollection(collection: string) {
    return {
      query: gql`
        subscription NoteAddedToCollection($collection: String!) {
          noteAddedToCollection(collection: $collection) {
            content
            id
          }
        }
      `,
      variables: { collection },
    };
  },
};

enum SubscriptionEventNames {
  noteAdded = "noteAdded",
  noteAddedToCollection = "noteAddedToCollection",
}

export interface INote {
  /** unique identifier for the note */
  id: string;
  /** collection id that the note is in */
  collection: string;
  /** main body content of the Note */
  content: string;
}

export interface IFanoutGraphqlTables {
  /** WebSocket-Over-Http Connections */
  connections: ISimpleTable<IStoredConnection>;
  /** Notes table */
  notes: ISimpleTable<INote>;
  /** PubSub Subscriptions */
  pubSubSubscriptions: ISimpleTable<IStoredPubSubSubscription>;
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
  collection: String!
  content: String!
  id: String!
}
input NotesQueryInput {
  collection: String
}
type Query {
  notes: [Note!]!
  getNotesByCollection(collection: String!): [Note!]!
}
input AddNoteInput {
  "Collection to add note to"
  collection: String!
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
    noteAddedToCollection(collection: String!): Note
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
  noteAddedToCollection(operationId: string, collection: string) {
    return `${
      SubscriptionEventNames.noteAddedToCollection
    }?${querystring.stringify(
      sorted({
        collection,
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
    case "noteAddedToCollection":
      const collection = interpolateValueNodeWithVariables(
        getQueryArgumentValue(gqlStartMessage.payload.query, "collection"),
        gqlStartMessage.payload.variables,
      );
      if (typeof collection !== "string") {
        throw new Error(
          `Expected collection argument value to be a string, but got ${collection}`,
        );
      }
      return gripChannelNames.noteAddedToCollection(gqlStartMessage.id, collection);
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

interface IFanoutGraphqlApolloOptions {
  /** grip uri */
  grip:
    | false
    | {
        /** GRIP URI for EPCP Gateway */
        url: string;
        /** Given a graphql-ws GQL_START message, return a string that is the Grip-Channel that the GRIP server should subscribe to for updates */
        getGripChannel?(gqlStartMessage: IGraphqlWsStartMessage): string;
      };
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
  interface INoteAddedToCollectionEvent {
    /** Event payload */
    noteAddedToCollection: INote;
  }
  const isNoteAddedEvent = (o: any): o is INoteAddedEvent => "noteAdded" in o;
  type SubscriptionEvent = INoteAddedEvent;
  // Provide resolver functions for your schema fields
  const resolvers: IResolvers = {
    Mutation: {
      async addNote(root, args, context) {
        const { note } = args;
        const noteId = uuidv4();
        const noteToInsert: INote = {
          ...note,
          id: noteId,
        };
        await options.tables.notes.insert(noteToInsert);
        if (pubsub) {
          await WebSocketOverHttpPubSubMixin(context)(pubsub).publish(
            SubscriptionEventNames.noteAdded,
            {
              noteAdded: noteToInsert,
            },
          );
        }
        return noteToInsert;
      },
    },
    Query: {
      getNotesByCollection: async (obj, args, context, info): Promise<INote[]> => {
        const notes: INote[] = [];
        await tables.notes.scan(async notesBatch => {
          notes.push(
            ...notesBatch.filter(note => note.collection === args.collection),
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
                    WebSocketOverHttpPubSubMixin(context)(pubsub).asyncIterator<
                      unknown
                    >([SubscriptionEventNames.noteAdded]),
                  (payload, variables) => {
                    return isNoteAddedEvent(payload);
                  },
                )(source, args, context, info);
                return noteAddedEvents;
              },
            },
            noteAddedToCollection: {
              subscribe(source, args, context, info) {
                const eventFilter = (event: object) =>
                  isNoteAddedEvent(event) &&
                  event.noteAdded.collection === args.collection;
                const noteAddedIterator = WebSocketOverHttpPubSubMixin(context)(
                  pubsub,
                ).asyncIterator([SubscriptionEventNames.noteAdded]);
                const iterable = {
                  [Symbol.asyncIterator]() {
                    return noteAddedIterator;
                  },
                };
                const notesAddedToCollection = pipe(
                  filter(eventFilter),
                  map(event => {
                    return {
                      noteAddedToCollection: event.noteAdded,
                    };
                  }),
                )(iterable);
                // Have to use this $$asyncIterator from iterall so that graphql/subscription will recognize this as an AsyncIterable
                // even when compiled for node version 8, which doesn't have Symbol.asyncIterator
                return {
                  [$$asyncIterator]() {
                    return notesAddedToCollection[Symbol.asyncIterator]();
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

  const schema = makeExecutableSchema({ typeDefs, resolvers });

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
      ...(options.grip
        ? WebSocketOverHttpContextFunction({
            grip: options.grip,
            pubSubSubscriptionStorage: options.tables.pubSubSubscriptions,
            schema,
          })
        : {}),
    };
    return context;
  };

  // const DebugApolloServerPlugin = (): ApolloServerPlugin => ({
  //   requestDidStart(requestContext) {
  //     console.log("requestDidStart");
  //   },
  // });

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
