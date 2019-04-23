import { ApolloServerBase, Context, formatApolloErrors } from "apollo-server-core";
import {
  execute,
  ExecutionResult,
  subscribe,
} from 'graphql';
import { Server as HttpServer } from 'http';
import {
  ExecutionParams,
  SubscriptionServer,
} from 'subscriptions-transport-ws';

type Constructor<T = {}> = new (...args: any[]) => T;

/**
 * Mixin to ApolloServerBase to override the `installSubscriptionHandlers` method to use a custom implementation of SubscriptionServer.
 * Without this, it is hardcoded to use the one from subscription-transport-ws.
 */
const WithCustomSubscriptions = <ApolloServerConstructor extends Constructor<ApolloServerBase>>(
  ApolloServer: ApolloServerConstructor,
  createSubscriptionServer: typeof SubscriptionServer.create,
): Constructor<ApolloServerBase> => {
  return class ApolloServerWithCustomSubscriptions extends ApolloServer {
    /**
     * Modify an HttpServer so that it serves graphql-ws requests.
     * This also creates a SubscriptionServer and assigns it to this.subscriptionServer.
     * https://www.apollographql.com/docs/apollo-server/features/subscriptions#middleware
     */
    public installSubscriptionHandlers(server: HttpServer) {
      if (!this.subscriptionServerOptions) {
        if (this.supportsSubscriptions()) {
          throw Error(
            'Subscriptions are disabled, due to subscriptions set to false in the ApolloServer constructor',
          );
        } else {
          throw Error(
            'Subscriptions are not supported, choose an integration, such as apollo-server-express that allows persistent connections',
          );
        }
      }

      const {
        onDisconnect,
        onConnect,
        keepAlive,
        path,
      } = this.subscriptionServerOptions;

      this.subscriptionServer = createSubscriptionServer(
        {
          execute,
          keepAlive,
          onConnect: onConnect
            ? onConnect
            : (connectionParams: object) => ({ ...connectionParams }),
          onDisconnect,
          onOperation: async (
            message: {
              /** message payload for this operation */
              payload: any
            },
            connection: ExecutionParams,
          ) => {
            connection.formatResponse = (value: ExecutionResult) => ({
              ...value,
              errors:
                value.errors &&
                formatApolloErrors([...value.errors], {
                  debug: this.requestOptions.debug,
                  formatter: this.requestOptions.formatError,
                }),
            });
            let context: Context = this.context ? this.context : { connection };

            try {
              context =
                typeof this.context === 'function'
                  ? await this.context({ connection, payload: message.payload })
                  : context;
            } catch (e) {
              throw formatApolloErrors([e], {
                debug: this.requestOptions.debug,
                formatter: this.requestOptions.formatError,
              })[0];
            }

            return { ...connection, context };
          },
          schema: this.schema,
          subscribe,
        },
        {
          path,
          server,
        },
      );
    }
  };
}
