import { gql } from "apollo-server-core";
import { Config as ApolloServerConfig } from "apollo-server-core";
import { IResolvers } from "graphql-tools";
import * as uuidv4 from "uuid/v4";
import { ISimpleTable } from "./SimpleTable";

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

export const FanoutGraphqlApolloConfig = (
  tables: IFanoutGraphqlTables,
): ApolloServerConfig => {
  // Construct a schema, using GraphQL schema language
  const typeDefs = gql`
    type Note {
      content: String!
    }
    input AddNoteInput {
      "The main body content of the Note"
      content: String!
    }
    type Query {
      hello: String
      notes: [Note!]!
    }
    type Mutation {
      addNote(note: AddNoteInput!): Note
    }
  `;

  // Provide resolver functions for your schema fields
  const resolvers: IResolvers = {
    Mutation: {
      async addNote(root, { note }) {
        const noteId = uuidv4();
        const noteToInsert = {
          ...note,
          id: noteId,
        };
        await tables.notes.insert(noteToInsert);
        return noteToInsert;
      },
    },
    Query: {
      hello: () => "Hello world! (from fanout.io)",
      notes: () => {
        return tables.notes.scan();
      },
    },
  };

  return { typeDefs, resolvers };
};

export default FanoutGraphqlApolloConfig;
