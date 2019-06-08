import {
  AsyncTest,
  Expect,
  FocusTest,
  IgnoreTest,
  TestCase,
  TestFixture,
  Timeout,
} from "alsatian";
import { cli } from "../test/cli";
import {
  getQueryArgumentValue,
  interpolateValueNodeWithVariables,
} from "./GraphqlQueryTools";

/** Test ./GraphqlQueryTools */
@TestFixture()
export class GraphqlQueryToolsTest {
  /** Test getQueryArgumentValue can get the value of a variable from a query string + variables */
  @TestCase({
    query: `
      subscription {
        noteAddedToChannel(channel: "#general") {
          content
          channel
          id
        }
      }
    `,
    variables: {},
  })
  @TestCase({
    query: `
      subscription NoteAddedToChannel($channelSubscriptionArg: String!) {
        noteAddedToChannel(channel: $channelSubscriptionArg) {
          content
          id
          __typename
        }
      }
    `,
    variables: {
      channelSubscriptionArg: "#general",
    },
  })
  @AsyncTest()
  public async testGetQueryArgumentValueAndInterpolateVariables({
    query,
    variables,
  }: {
    /** graphql query */
    query: string;
    /** variables that should be provided to query (or empty object) */
    variables: object | {};
  }) {
    const argumentName = "channel";
    const expectedArgumentValue = "#general";
    const argumentValueNode = getQueryArgumentValue(query, argumentName);
    const actualArgumentValue = interpolateValueNodeWithVariables(
      argumentValueNode,
      variables,
    );
    Expect(actualArgumentValue).toEqual(expectedArgumentValue);
  }
}

if (require.main === module) {
  cli(__filename).catch((error: Error) => {
    throw error;
  });
}
