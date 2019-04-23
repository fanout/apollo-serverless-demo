import { AsyncTest, Expect, Test, TestCase, TestFixture } from "alsatian";
import { cli } from "../test/cli"

/** Test ApolloServerCustomSubscriptions */
@TestFixture()
class ApolloServerCustomSubscriptionsTestSuite {
  // @AsyncTest()
  // public test() {

  // }
}

if (require.main === module) {
  cli(__filename).catch(error => {
          throw error;
  });
}
