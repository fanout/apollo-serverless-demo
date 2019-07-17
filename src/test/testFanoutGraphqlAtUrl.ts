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
    addNote(collection: string, content: string) {
      return {
        mutation: gql`
          mutation AddNote($collection: String!, $content: String!) {
            addNote(note: { collection: $collection, content: $content }) {
              content
              id
            }
          }
        `,
        variables: { collection, content },
      };
    },
  };
  const newNoteContent = "I'm from a test";
  const collectionA = "a";
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
    mutations.addNote(collectionA, newNoteContent),
  );
  const firstEvent = await promiseFirstSubscriptionEvent;
  Expect(firstEvent.data.noteAdded.content).toEqual(newNoteContent);
  Expect(firstEvent.data.noteAdded.id).toEqual(mutationResult.data.addNote.id);

  // Add a second note in another collection
  const collectionB = "b";
  const b1MutationResult = await apolloClient.mutate(
    mutations.addNote(collectionB, "b1"),
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
    GetNotesByCollection: gql`
      query GetNotesByCollection($collection: String!) {
        getNotesByCollection(collection: $collection) {
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

  // Now let's make sure we can query for notes by collection
  // Starting with collection A
  const queryCollectionANotesResult = await apolloClient.query({
    query: queries.GetNotesByCollection,
    variables: {
      collection: collectionA,
    },
  });
  Expect(queryCollectionANotesResult).toBeTruthy();
  Expect(queryCollectionANotesResult.data.getNotesByCollection.length).toEqual(1);
  Expect(queryCollectionANotesResult.data.getNotesByCollection[0].content).toEqual(
    newNoteContent,
  );
  Expect(queryCollectionANotesResult.data.getNotesByCollection[0].id).toEqual(
    mutationResult.data.addNote.id,
  );
  // and collection B
  const queryCollectionBNotesResult = await apolloClient.query({
    query: queries.GetNotesByCollection,
    variables: {
      collection: collectionB,
    },
  });
  Expect(queryCollectionBNotesResult).toBeTruthy();
  Expect(queryCollectionBNotesResult.data.getNotesByCollection.length).toEqual(1);
  Expect(queryCollectionBNotesResult.data.getNotesByCollection[0].content).toEqual(
    b1MutationResult.data.addNote.content,
  );
  Expect(queryCollectionBNotesResult.data.getNotesByCollection[0].id).toEqual(
    b1MutationResult.data.addNote.id,
  );

  // Now let's test subscribing to a specific collection.
  // We'll open a subscription for collection A,
  // Then post two notes, one to collection A and one to B,
  // then assert that the subscription only got the note from collection A
  const collectionASubscriptionObservable = apolloClient.subscribe(
    FanoutGraphqlSubscriptionQueries.noteAddedToCollection(collectionA),
  );
  const {
    items: collectionASubscriptionGotItems,
    subscription: collectionASubscription,
  } = itemsFromLinkObservable(collectionASubscriptionObservable);
  const nextEventOnChannelAPromise = takeOne(collectionASubscriptionObservable);
  // subscription to collection A will kick off. Now let's add a note to collection A
  const a2MutationResult = await apolloClient.mutate(
    mutations.addNote(collectionA, "a2"),
  );
  const collectionAEvent = await nextEventOnChannelAPromise;
  Expect(collectionAEvent).toBeTruthy();
  Expect(collectionAEvent.data.noteAddedToCollection.id).toEqual(
    a2MutationResult.data.addNote.id,
  );

  // Now publish something to collection b
  // We want to make sure it doesn't come down the collection a subscription
  // But it does come down a collection b subscription
  const collectionBObservable = apolloClient.subscribe(
    FanoutGraphqlSubscriptionQueries.noteAddedToCollection(collectionB),
  );
  const nextEventOnChannelBPromise = takeOne(collectionBObservable);
  const b2MutationResult = await apolloClient.mutate(
    mutations.addNote(collectionB, "b2"),
  );
  const collectionBEvent = await nextEventOnChannelBPromise;
  Expect(collectionBEvent.data.noteAddedToCollection.id).toEqual(
    b2MutationResult.data.addNote.id,
  );
  // should not have resulted in anything (new) on the collection A subscription
  Expect(collectionASubscriptionGotItems.length).toEqual(1);
  // should have resulted in an event on all-collection noteAdded subscription
  const lastNoteAdded = noteAddedSubscriptionItems.slice(-1)[0];
  Expect(lastNoteAdded).toBeTruthy();
  Expect(lastNoteAdded.data.noteAdded.id).toEqual(
    b2MutationResult.data.addNote.id,
  );

  // clean up
  noteAddedSubscription.unsubscribe();
  collectionASubscription.unsubscribe();
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
