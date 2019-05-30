import { PubSub, PubSubEngine } from "apollo-server";
import { Context, SubscriptionServerOptions } from "apollo-server-core";
import { ExpressContext } from "apollo-server-express/dist/ApolloServer";
import { IResolvers, makeExecutableSchema } from "graphql-tools";
import * as uuidv4 from "uuid/v4";
import { ISimpleTable } from "./SimpleTable";

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
    noteAdded: Note!
  }
  `
    : ""
}
`;

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

  // Provide resolver functions for your schema fields
  const resolvers: IResolvers = {
    Mutation: {
      async addNote(root, args) {
        const { note } = args;
        const noteId = uuidv4();
        const noteToInsert = {
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
              subscribe() {
                return (
                  pubsub &&
                  pubsub.asyncIterator([SubscriptionEventNames.noteAdded])
                );
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
