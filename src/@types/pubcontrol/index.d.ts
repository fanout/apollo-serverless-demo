declare module "pubcontrol" {
  // tslint:disable:max-classes-per-file
  // tslint:disable:completed-docs
  interface IPubControlItemExported<FormatName extends string> {
    id: string;
    "prev-id": string;
    // compiler doesn't like this but that's how it works
    // [k: FormatName]: object;
  }
  interface IPubControlItemFormat {
    name(): string;
    // if content-bin, it's base64-encoded
    export(): { content: string } | { "content-bin": string };
  }
  export class Item<FormatName extends string> {
    public formats: IPubControlItemFormat[];
    public prevId?: string;
    public id?: string;
    constructor(
      formats: IPubControlItemFormat | IPubControlItemFormat[],
      id?: string,
      prevId?: string,
    );
    public export(): IPubControlItemExported<FormatName>;
  }
  type IPubControlCallback = (
    success: boolean,
    message: string,
    context: object,
  ) => void;
  export class PubControlClient {
    public uri: string;
    public auth: null;
    constructor(uri: string);
    public setAuthBasic(username: string, password: string): void;
    public setAuthJwt(claim: object, key?: string): void;
    public publish<FormatName extends string>(
      channel: string,
      item: Item<FormatName>,
      callback: IPubControlCallback,
    ): void;
  }
  // tslint:disable:enable-docs
}
