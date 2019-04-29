declare module "killable" {
  import { Server } from "http";
  type KillableServerType = Server & {
    /** kill the http server, closing all connections */
    kill: (errback: (error?: Error) => void) => void;
  };
  // tslint:disable-next-line:completed-docs
  function killable(server: Server): KillableServerType;
  namespace killable {
    export type KillableServer = KillableServerType;
  }
  export = killable;
}
