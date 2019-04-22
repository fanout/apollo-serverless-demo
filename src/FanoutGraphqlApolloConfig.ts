import { gql } from "apollo-server-core";

interface INote {
  /** main body content of the Note */
  content: string;
}

export const FanoutGraphqlApolloConfig = () => {
  const notes = new Map<string, INote>();
  // Construct a schema, using GraphQL schema language
  const typeDefs = gql`
    type Note {
      content: String!
    }
    type Query {
      hello: String
      notes: [Note!]!
    }
  `;

  // Provide resolver functions for your schema fields
  const resolvers = {
    Query: {
      hello: () => "Hello world! (from fanout.io)",
      notes: () => Array.from(notes.values()),
    },
  };

  return { typeDefs, resolvers };
};

export default FanoutGraphqlApolloConfig;
