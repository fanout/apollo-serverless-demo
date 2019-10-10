import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";
import { IFanoutGraphqlServerGripOptions } from "../FanoutGraphqlExpressServer";

const simpleWorkerScriptContent = (): string => {
  return fs.readFileSync(path.join(__dirname, "simpleWorker.js"), "utf8");
}

/**
 * Pulumi Resource for cloudflare resources required for Fanout Graphql App
 */
export default class FanoutGraphqlCloudflareApp extends pulumi.ComponentResource {
  constructor(
    name: string,
    args: {
      /** Zone ID of cloudflare DNS zone at which to create a route to the worker */
      cloudflareZoneId: string;
      /** url patterns to route to the worker, e.g. 'domain.com/something/*' */
      routePattern: string;
    },
    opts?: pulumi.ResourceOptions) {
    super("FanoutGraphqlCloudflareApp", name, {}, opts);

    // Cloudflare Worker Script
    const cfWorkerScript = new cloudflare.WorkerScript(`${name}-workerScript`, {
      content: simpleWorkerScriptContent(),
      name: `${name}`,
    }, { parent: this });
    // Cloudflare Worker Route
    // so we can actually run the Worker Script
    const cfWorkerRoute = new cloudflare.WorkerRoute(`${name}-workerRoute`,
      {
        pattern: args.routePattern,
        scriptName: cfWorkerScript.name,
        zoneId: args.cloudflareZoneId,
      },
      { parent: this },
    ) 
  }
}

