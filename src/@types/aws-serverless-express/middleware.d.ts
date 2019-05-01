import { RequestHandler } from "express";

// tslint:disable:completed-docs
// tslint:disable:interface-name

export interface Options {
  reqPropKey?: string;
  deleteHeaders?: boolean;
}

export function eventContext(options?: Options): RequestHandler;
