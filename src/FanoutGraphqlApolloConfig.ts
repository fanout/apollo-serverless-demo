import { gql } from "apollo-server-core";

export const FanoutGraphqlApolloConfig = () => {
  // Construct a schema, using GraphQL schema language
  const typeDefs = gql`
    type Query {
      hello: String
    }
  `;

  // Provide resolver functions for your schema fields
  const resolvers = {
    Query: {
      hello: () => "Hello world! (from fanout.io)",
    }
  };

  return { typeDefs, resolvers };
};

export default FanoutGraphqlApolloConfig;
