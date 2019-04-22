import { gql } from "apollo-server-core";
import { Config as ApolloServerConfig } from "apollo-server-core";
import { IResolvers } from "graphql-tools";
import * as uuidv4 from "uuid/v4";

interface INote {
  /** main body content of the Note */
  content: string;
}

export const FanoutGraphqlApolloConfig = (): ApolloServerConfig => {
  const notes = new Map<string, INote>();
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
      addNote(root, { note }) {
        const noteId = uuidv4();
        notes.set(noteId, {
          ...note,
          id: noteId,
        });
        return notes.get(noteId);
      },
    },
    Query: {
      hello: () => "Hello world! (from fanout.io)",
      notes: () => Array.from(notes.values()),
    },
  };

  return { typeDefs, resolvers };
};

export default FanoutGraphqlApolloConfig;
