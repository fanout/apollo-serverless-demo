import { Expect } from "alsatian";
import { gql } from "apollo-server";
import { basename } from "path";
import * as url from "url";
import { FanoutGraphqlSubscriptionQueries } from "../FanoutGraphqlApolloConfig";
import { IApolloServerUrlInfo } from "../FanoutGraphqlExpressServer";
import { takeOne } from "../observable-tools";
import WebSocketApolloClient from "../WebSocketApolloClient";

/** return promise that resolves after some milliseconds */
export const timer = (ms: number) =>
  new Promise(resolve => setTimeout(resolve, ms));

/** Test a URL to ensure it properly serves Fanout GraphQL Demo (notes, addNote, noteAdded) */
export async function FanoutGraphqlHttpAtUrlTest(
  urls: IApolloServerUrlInfo,
  /** return promise of when the latest websocket changes. Will be waited for between subscription and mutation */
  socketChangedEvent: () => Promise<any>,
) {
  const mutations = {
    addNote: gql`
      mutation AddNote($channel: String!, $content: String!) {
        addNote(note: { channel: $channel, content: $content }) {
          content
          id
        }
      }
    `,
  };
  const newNoteContent = "I'm from a test";
  const channelA = "a";
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
    mutation: mutations.addNote,
    variables: {
      channel: channelA,
      content: newNoteContent,
    },
  });
  const firstEvent = await promiseFirstSubscriptionEvent;
  Expect(firstEvent.data.noteAdded.content).toEqual(newNoteContent);
  Expect(firstEvent.data.noteAdded.id).toEqual(mutationResult.data.addNote.id);

  // Add a second note in another channel
  const channelB = "b";
  const b1MutationResult = await apolloClient.mutate({
    mutation: mutations.addNote,
    variables: {
      channel: channelB,
      content: "b1",
    },
  });

  const queries = {
    GetAllNotes: gql`
      query GetAllNotes {
        notes {
          content
          id
        }
      }
    `,
    GetNotesByChannel: gql`
      query GetNotesByChannel($channel: String!) {
        getNotesByChannel(channel: $channel) {
          content
          id
        }
      }
    `,
  };

  // Now let's make sure we can query for all notes
  const queryAllNotesResult = await apolloClient.query({
    query: queries.GetAllNotes,
  });
  Expect(queryAllNotesResult).toBeTruthy();
  Expect(queryAllNotesResult.data.notes.length).toEqual(2);

  // Now let's make sure we can query for notes by channel
  // Starting with channel A
  const queryChannelANotesResult = await apolloClient.query({
    query: queries.GetNotesByChannel,
    variables: {
      channel: channelA,
    },
  });
  Expect(queryChannelANotesResult).toBeTruthy();
  Expect(queryChannelANotesResult.data.getNotesByChannel.length).toEqual(1);
  Expect(queryChannelANotesResult.data.getNotesByChannel[0].content).toEqual(
    newNoteContent,
  );
  Expect(queryChannelANotesResult.data.getNotesByChannel[0].id).toEqual(
    mutationResult.data.addNote.id,
  );
  // and channel B
  const queryChannelBNotesResult = await apolloClient.query({
    query: queries.GetNotesByChannel,
    variables: {
      channel: channelB,
    },
  });
  Expect(queryChannelBNotesResult).toBeTruthy();
  Expect(queryChannelBNotesResult.data.getNotesByChannel.length).toEqual(1);
  Expect(queryChannelBNotesResult.data.getNotesByChannel[0].content).toEqual(
    b1MutationResult.data.addNote.content,
  );
  Expect(queryChannelBNotesResult.data.getNotesByChannel[0].id).toEqual(
    b1MutationResult.data.addNote.id,
  );
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
