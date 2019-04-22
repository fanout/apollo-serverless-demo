import { ApolloServer } from "apollo-server";
import FanoutGraphqlApolloConfig from "./FanoutGraphqlApolloConfig";

const FanoutGraphqlServer = () => {
  const apolloServer = new ApolloServer(FanoutGraphqlApolloConfig());
  return apolloServer;
};

const main = async () => {
  const server = FanoutGraphqlServer();
  server.listen(process.env.PORT || 0).then(({ url }) => {
    console.log(`🚀 Server ready at ${url}`);
  });
};

if (require.main === module) {
  main().catch(error => {
    throw error;
  });
}
