import { PubSub, PubSubEngine } from "apollo-server";
import { Context, gql, SubscriptionServerOptions } from "apollo-server-core";
import { Config as ApolloServerConfig } from "apollo-server-core";
import { ExpressContext } from "apollo-server-express/dist/ApolloServer";
import { ApolloServerPlugin } from "apollo-server-plugin-base";
import { IResolvers, makeExecutableSchema } from "graphql-tools";
import * as uuidv4 from "uuid/v4";
import { ISimpleTable } from "./SimpleTable";

/** Common queries for this API */
export const FanoutGraphqlSubscriptionQueries = {
  noteAdded: `
    subscription {
      noteAdded {
        content
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
input AddNoteInput {
  "The main body content of the Note"
  content: String!
}
type Note {
  content: String!
}
type Query {
  hello: String
  notes: [Note!]!
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

/**
 * ApolloServer.Config that will configure an ApolloServer to serve the FanoutGraphql graphql API.
 * @param pubsub - If not provided, subscriptions will not be enabled
 */
export const FanoutGraphqlApolloConfig = (
  tables: IFanoutGraphqlTables,
  pubsub?: PubSubEngine,
) => {
  if (!pubsub) {
    console.debug(
      "FanoutGraphqlApolloConfig: no pubsub provided. Subscriptions will be disabled.",
    );
  }

  // Construct a schema, using GraphQL schema language
  const typeDefs = FanoutGraphqlTypeDefs(Boolean(pubsub));

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
        await tables.notes.insert(noteToInsert);
        if (pubsub) {
          await pubsub.publish(SubscriptionEventNames.noteAdded, {
            noteAdded: noteToInsert,
          });
        }
        return noteToInsert;
      },
    },
    Query: {
      hello: () => "Hello world! (from fanout.io)",
      notes: () => {
        return tables.notes.scan();
      },
    },
    ...(pubsub
      ? {
          Subscription: {
            noteAdded: {
              subscribe() {
                return pubsub.asyncIterator([SubscriptionEventNames.noteAdded]);
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

  const DebugApolloServerPlugin = (): ApolloServerPlugin => ({
    requestDidStart(requestContext) {
      console.log("requestDidStart");
    },
  });

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
