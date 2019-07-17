import { Expect } from "alsatian";
import { Observable } from "apollo-link";
import { gql } from "apollo-server";
import { basename } from "path";
import * as url from "url";
import { FanoutGraphqlSubscriptionQueries } from "../FanoutGraphqlApolloConfig";
import { IApolloServerUrlInfo } from "../FanoutGraphqlExpressServer";
import { takeOne } from "../observable-tools";
import WebSocketApolloClient from "../WebSocketApolloClient";

/**
 * Given an observable, subscribe to it and return the subscription as well as an array that will be pushed to whenever an item is sent to subscription.
 *
 */
export const itemsFromLinkObservable = <T>(
  observable: Observable<T>,
): {
  /** Array of items that have come from the subscription */
  items: T[];
  /** Subscription that can be unsubscribed to */
  subscription: ZenObservable.Subscription;
} => {
  const items: T[] = [];
  const subscription = observable.subscribe({
    next(item) {
      items.push(item);
    },
  });
  return { items, subscription };
};

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
    addNote(channel: string, content: string) {
      return {
        mutation: gql`
          mutation AddNote($channel: String!, $content: String!) {
            addNote(note: { channel: $channel, content: $content }) {
              content
              id
            }
          }
        `,
        variables: { channel, content },
      };
    },
  };
  const newNoteContent = "I'm from a test";
  const channelA = "a";
  const apolloClient = WebSocketApolloClient(urls);

  const noteAddedSubscriptionObservable = apolloClient.subscribe(
    FanoutGraphqlSubscriptionQueries.noteAdded(),
  );
  const {
    items: noteAddedSubscriptionItems,
    subscription: noteAddedSubscription,
  } = itemsFromLinkObservable(noteAddedSubscriptionObservable);
  const promiseFirstSubscriptionEvent = takeOne(
    noteAddedSubscriptionObservable,
  );
  // Wait until the server actually gets the subscription connection to issue the mutation,
  // otherwise we may not actually receive it.
  await socketChangedEvent();
  const mutationResult = await apolloClient.mutate(
    mutations.addNote(channelA, newNoteContent),
  );
  const firstEvent = await promiseFirstSubscriptionEvent;
  Expect(firstEvent.data.noteAdded.content).toEqual(newNoteContent);
  Expect(firstEvent.data.noteAdded.id).toEqual(mutationResult.data.addNote.id);

  // Add a second note in another channel
  const channelB = "b";
  const b1MutationResult = await apolloClient.mutate(
    mutations.addNote(channelB, "b1"),
  );
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

  // Now let's test subscribing to a specific channel.
  // We'll open a subscription for channel A,
  // Then post two notes, one to channel A and one to B,
  // then assert that the subscription only got the note from channel A
  const channelASubscriptionObservable = apolloClient.subscribe(
    FanoutGraphqlSubscriptionQueries.noteAddedToChannel(channelA),
  );
  const {
    items: channelASubscriptionGotItems,
    subscription: channelASubscription,
  } = itemsFromLinkObservable(channelASubscriptionObservable);
  const nextEventOnChannelAPromise = takeOne(channelASubscriptionObservable);
  // subscription to channel A will kick off. Now let's add a note to channel A
  const a2MutationResult = await apolloClient.mutate(
    mutations.addNote(channelA, "a2"),
  );
  const channelAEvent = await nextEventOnChannelAPromise;
  Expect(channelAEvent).toBeTruthy();
  Expect(channelAEvent.data.noteAddedToChannel.id).toEqual(
    a2MutationResult.data.addNote.id,
  );

  // Now publish something to channel b
  // We want to make sure it doesn't come down the channel a subscription
  // But it does come down a channel b subscription
  const channelBObservable = apolloClient.subscribe(
    FanoutGraphqlSubscriptionQueries.noteAddedToChannel(channelB),
  );
  const nextEventOnChannelBPromise = takeOne(channelBObservable);
  const b2MutationResult = await apolloClient.mutate(
    mutations.addNote(channelB, "b2"),
  );
  const channelBEvent = await nextEventOnChannelBPromise;
  Expect(channelBEvent.data.noteAddedToChannel.id).toEqual(
    b2MutationResult.data.addNote.id,
  );
  // should not have resulted in anything (new) on the channel A subscription
  Expect(channelASubscriptionGotItems.length).toEqual(1);
  // should have resulted in an event on all-channel noteAdded subscription
  const lastNoteAdded = noteAddedSubscriptionItems.slice(-1)[0];
  Expect(lastNoteAdded).toBeTruthy();
  Expect(lastNoteAdded.data.noteAdded.id).toEqual(
    b2MutationResult.data.addNote.id,
  );

  // clean up
  noteAddedSubscription.unsubscribe();
  channelASubscription.unsubscribe();
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
