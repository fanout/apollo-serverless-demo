declare module "killable" {
  import { Server } from "http";
  type KillableServerType = Server & { kill: (cb: Function) => void };
  function killable(server: Server): KillableServerType;
  namespace killable {
    export type KillableServer = KillableServerType;
  }
  export = killable;
}
