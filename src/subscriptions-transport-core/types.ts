/**
 * Generic tools/interfaces for GraphQL SubscriptionServers.
 * This can be used to use implementations other than the subscriptions-transport-ws that is tightly coupled with apollo-server-core.
 * Much of the underlying types were pulled from ApolloServerBase and subscriptions-transport-ws, but with any mention of WebSockets removed or not required.
 */
import {
  DocumentNode,
  ExecutionResult,
  GraphQLFieldResolver,
  GraphQLSchema,
  ValidationContext,
} from "graphql";
import * as http from "http";

type AnyFunction = (...args: any[]) => any;

export type ExecuteFunction = (
  schema: GraphQLSchema,
  document: DocumentNode,
  rootValue?: any,
  contextValue?: any,
  variableValues?: {
    [key: string]: any;
  },
  operationName?: string,
  fieldResolver?: GraphQLFieldResolver<any, any>,
) =>
  | ExecutionResult
  | Promise<ExecutionResult>
  | AsyncIterator<ExecutionResult>;
export type SubscribeFunction = (
  schema: GraphQLSchema,
  document: DocumentNode,
  rootValue?: any,
  contextValue?: any,
  variableValues?: {
    [key: string]: any;
  },
  operationName?: string,
  fieldResolver?: GraphQLFieldResolver<any, any>,
  subscribeFieldResolver?: GraphQLFieldResolver<any, any>,
) =>
  | AsyncIterator<ExecutionResult>
  | Promise<AsyncIterator<ExecutionResult> | ExecutionResult>;

/**
 * Copied from subscriptions-transport-ws
 */
// tslint:disable:completed-docs
export interface ISubscriptionServerOptions {
  rootValue?: any;
  schema?: GraphQLSchema;
  execute?: ExecuteFunction;
  subscribe?: SubscribeFunction;
  validationRules?:
    | Array<(context: ValidationContext) => any>
    | ReadonlyArray<any>;
  onOperation?: AnyFunction;
  onOperationComplete?: AnyFunction;
  onConnect?: AnyFunction;
  onDisconnect?: AnyFunction;
  keepAlive?: number;
}
// tslint:enable:completed-docs

export interface ISubscriptionServer {
  /** Shut down the server */
  close(): void;
}

/**
 * Copied from subscription-transport-ws to remove dependency on that
 */
export interface ISubscriptionServerExecutionParams<TContext = any> {
  // tslint:disable:completed-docs
  query: string | DocumentNode;
  variables: {
    [key: string]: any;
  };
  operationName?: string;
  context: TContext;
  formatResponse?: AnyFunction;
  formatError?: AnyFunction;
  callback?: AnyFunction;
  schema?: GraphQLSchema;
}
// tslint:enable:completed-docs

interface ISubscriptionServerInstallationTarget {
  /** Path at which the SubscriptionServer should watch for new connections */
  path: string;
  /** HTTP Server to modify to accept subscriptions */
  server: http.Server;
}

/** e.g. subscriptions-transport-ws SubscriptionServer.create */
type SubscriptionServerCreator = (
  opts: ISubscriptionServerOptions,
  installTo: ISubscriptionServerInstallationTarget,
) => ISubscriptionServer;

interface ISubscriptionServerInstallation {
  /** SubscriptionServer instance that was created as part of installation */
  subscriptionServer: ISubscriptionServer;
}
