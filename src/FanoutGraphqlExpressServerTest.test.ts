import {
  AsyncTest,
  Expect,
  Test,
  TestCase,
  TestFixture,
  Timeout,
} from "alsatian";
import { PubSub } from "apollo-server";
import { ApolloServer as ApolloServerExpress } from "apollo-server-express";
import { EventEmitter } from "events";
import * as express from "express";
import * as http from "http";
import { AddressInfo } from "net";
import { format as urlFormat } from "url";
import { promisify } from "util";
import FanoutGraphqlApolloConfig from "./FanoutGraphqlApolloConfig";
import {
  ApolloServerExpressApp,
  apolloServerInfo,
} from "./FanoutGraphqlExpressServer";
import { MapSimpleTable } from "./SimpleTable";
import { cli } from "./test/cli";
import { FanoutGraphqlHttpAtUrlTest } from "./test/testFanoutGraphqlAtUrl";

const hostOfAddressInfo = (address: AddressInfo): string => {
  const host =
    address.address === "" || address.address === "::"
      ? "localhost"
      : address.address;
  return host;
};

const urlOfServerAddress = (address: AddressInfo): string => {
  return urlFormat({
    hostname: hostOfAddressInfo(address),
    port: address.port,
    protocol: "http",
  });
};

interface IListeningServerInfo {
  /** url at which the server can be reached */
  url: string;
  /** host of server */
  hostname: string;
  /** port of server */
  port: number;
}

const withListeningServer = (httpServer: http.Server) => async (
  doWorkWithServer: (serverInfo: IListeningServerInfo) => Promise<void>,
) => {
  // listen
  await new Promise((resolve, reject) => {
    httpServer.on("listening", resolve);
    httpServer.on("error", error => {
      reject(error);
    });
    httpServer.listen(0);
  });
  const address = httpServer.address();
  if (typeof address === "string" || !address) {
    throw new Error(`Can't determine URL from address ${address}`);
  }
  await doWorkWithServer({
    hostname: hostOfAddressInfo(address),
    port: address.port,
    url: urlOfServerAddress(address),
  });
  await promisify(httpServer.close.bind(httpServer));
};

const ChangingValue = <T>(): [
  (v: T) => void,
  () => Promise<T>,
  () => Promise<T>
] => {
  let value: T | undefined;
  let valueIsSet = false;
  const emitter = new EventEmitter();
  const setValue = (valueIn: T) => {
    value = valueIn;
    valueIsSet = true;
    emitter.emit("value", value);
  };
  const getNextValue = async (): Promise<T> => {
    return new Promise((resolve, reject) => {
      emitter.on("value", resolve);
    });
  };
  const getValue = async (): Promise<T> => {
    if (valueIsSet) {
      return value as T;
    }
    return getNextValue();
  };
  return [setValue, getValue, getNextValue];
};

/** Test FanoutGraphqlExpressServer */
@TestFixture()
export class FanoutGraphqlExpressServerTestSuite {
  /** test */
  @Timeout(1000 * 60 * 60)
  @AsyncTest()
  public async testCreateWebsocketSubscriptionServer() {
    const apolloConfig = FanoutGraphqlApolloConfig(
      {
        notes: MapSimpleTable(),
      },
      new PubSub(),
    );
    /** Keep track of subscription connections so we can wait for them to be established below */
    const [setLatestSocket, _, socketChangedEvent] = ChangingValue();
    const apolloServer = new ApolloServerExpress({
      ...apolloConfig,
      introspection: true,
      playground: true,
      subscriptions: {
        ...apolloConfig.subscriptions,
        onConnect(opts, socket) {
          setLatestSocket(socket);
        },
      },
    });
    const expressApp = express()
      .use((req, res, next) => {
        next();
      })
      .use(ApolloServerExpressApp(apolloServer));
    const httpServer = http.createServer(expressApp);
    apolloServer.installSubscriptionHandlers(httpServer);
    await withListeningServer(httpServer)(async () => {
      const apolloUrls = apolloServerInfo(httpServer, {
        graphqlPath: "/",
        subscriptionsPath: "/",
      });
      console.log("about to testFanoutGraphqlHttpAtUrl", apolloUrls);
      await FanoutGraphqlHttpAtUrlTest(
        apolloUrls.url,
        apolloUrls.subscriptionsUrl,
        socketChangedEvent,
      );
    });
  }
}

if (require.main === module) {
  cli(__filename).catch((error: Error) => {
    throw error;
  });
}
