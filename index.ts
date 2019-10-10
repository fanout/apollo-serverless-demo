import * as awsx from "@pulumi/awsx";
import * as pulumi from "@pulumi/pulumi";
import FanoutGraphqlCloudflareApp from "./api/_lib/cloudflare/FanoutGraphqlCloudflareApp";
import FanoutGraphqlAwsApp from "./api/_lib/FanoutGraphqlAwsApp";

enum FaasProvider {
  cloudflare = "cloudflare",
  aws = "aws",
}

const pulumiConfig = new pulumi.Config("fanout.io-lambda-demo");

const configFromPulumi = {
  // functions-as-a-service provider
  // one of: 'aws', 'cloudflare'
  faasProvider: pulumiConfig.require('faasProvider'),
  gripUrl: pulumiConfig.get("gripUrl"),
  // common name prefix for all pulumi component names, e.g. 'dev'
  name: pulumiConfig.require("name"),
};

const config = {
  // like https://api.fanout.io/realm/{realm-id}?iss={realm-id}&key=base64:{realm-key}
  gripUrl: process.env.GRIP_URL || configFromPulumi.gripUrl,
  name: configFromPulumi.name,
};

if (configFromPulumi.faasProvider === FaasProvider.cloudflare) {
  const cloudflareApp = new FanoutGraphqlCloudflareApp(
    `${config.name}-cloudflare`,
    {
      cloudflareZoneId: "99aa670370099e71bb3a711a53bc4e7e",
      routePattern: "activitypubbers.com/graphql/*",
    },
  )
}

const fanoutGraphqlAwsAppPulumiName = config.name;

const fanoutGraphqlAwsApp = FanoutGraphqlAwsApp(
  `${fanoutGraphqlAwsAppPulumiName}-lambda`,
  {
    grip: config.gripUrl ? { url: config.gripUrl } : false,
  },
);

const endpoint = new awsx.apigateway.API(
  `${fanoutGraphqlAwsAppPulumiName}-api-gateway`,
  {
    routes: fanoutGraphqlAwsApp.routes,
  },
);

/** URL of FanoutGraphglAwsApp API Gateway */
export const url = endpoint.url;
