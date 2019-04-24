import { Observable } from "subscriptions-transport-ws";

/** return promise of one item on observable */
export const takeOne = async <T extends any>(
  observable: Observable<T>,
): Promise<T> => {
  return new Promise((resolve, reject) => {
    const subscription = observable.subscribe({
      error: error => {
        subscription.unsubscribe();
        reject(error);
      },
      next: val => {
        subscription.unsubscribe();
        resolve(val);
      },
    });
  });
};
