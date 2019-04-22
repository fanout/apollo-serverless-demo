import { ApolloServer } from "apollo-server";
import FanoutGraphqlApolloConfig, {
  IFanoutGraphqlTables,
  INote,
} from "./FanoutGraphqlApolloConfig";
import { MapSimpleTable } from "./SimpleTable";

/**
 * ApolloServer configured for FanoutGraphql (not in lambda).
 */
export const FanoutGraphqlServer = (tables: IFanoutGraphqlTables) => {
  const apolloServer = new ApolloServer(FanoutGraphqlApolloConfig(tables));
  return apolloServer;
};

const main = async () => {
  const server = FanoutGraphqlServer({
    notes: MapSimpleTable<INote>(),
  });
  server.listen(process.env.PORT || 0).then(({ url }) => {
    console.log(`🚀 Server ready at ${url}`);
  });
};

if (require.main === module) {
  main().catch(error => {
    throw error;
  });
}
