import { Expect } from "alsatian";
import { gql } from "apollo-server";
import { basename } from "path";
import * as url from "url";
import { FanoutGraphqlSubscriptionQueries } from "../FanoutGraphqlApolloConfig";
import { IApolloServerUrlInfo } from "../FanoutGraphqlExpressServer";
import { takeOne } from "../observable-tools";
import WebSocketApolloClient from "../WebSocketApolloClient";

const timer = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Test a URL to ensure it properly serves Fanout GraphQL Demo (notes, addNote, noteAdded) */
export async function FanoutGraphqlHttpAtUrlTest(
  urls: IApolloServerUrlInfo,
  /** return promise of when the latest websocket changes. Will be waited for between subscription and mutation */
  socketChangedEvent: () => Promise<any>,
) {
  const newNoteContent = "I'm from a test";
  const apolloClient = WebSocketApolloClient(urls);
  const subscriptionObservable = apolloClient.subscribe({
    query: gql(FanoutGraphqlSubscriptionQueries.noteAdded),
    variables: {},
  });
  const promiseFirstSubscriptionEvent = takeOne(subscriptionObservable);
  // Wait until the server actually gets the subscription connection to issue the mutation,
  // otherwise we may not actually receive it.
  await socketChangedEvent();
  const mutationResult = await apolloClient.mutate({
    mutation: gql`
      mutation {
        addNote(note: { content: "${newNoteContent}" }) {
          content
        }
      }
    `,
  });
  const firstEvent = await promiseFirstSubscriptionEvent;
  Expect(firstEvent.data.noteAdded.content).toEqual(newNoteContent);
}

/**
 * Script to test a GraphQL Server at a given URL to make sure it adequately serves the FanoutGraphql app w/ subscriptions et al
 */
const main = async (urlArg: string) => {
  const parsedUrlArg = url.parse(urlArg);
  const httpUrl = url.format({ ...parsedUrlArg, protocol: "http" });
  const subscriptionsUrl = `ws://${url.format({
    ...parsedUrlArg,
    protocol: undefined,
  })}`;
  const urls = {
    subscriptionsUrl,
    url: httpUrl,
  };
  console.log("about to test for Fanout GraphQL", urls);
  await FanoutGraphqlHttpAtUrlTest(urls, () => timer(5000));
};

if (require.main === module) {
  const urlArg = process.argv[2] || "http://localhost:7999";
  if (!urlArg) {
    console.info(`usage: ts-node ${basename(__filename)} {url}`);
    process.exit(1);
  }
  main(urlArg).catch(error => {
    console.error(error);
    process.exit(1);
  });
}
