import * as awsx from "@pulumi/awsx";
import * as pulumi from "@pulumi/pulumi";
import FanoutGraphqlAwsApp from "./FanoutGraphqlAwsApp";

const pulumiConfig = new pulumi.Config("fanout.io-lambda-demo");

const configFromPulumi = {
  gripUrl: pulumiConfig.get("gripUrl"),
  // common name prefix for all pulumi component names, e.g. 'dev'
  name: pulumiConfig.require("name"),
};

const config = {
  // like https://api.fanout.io/realm/{realm-id}?iss={realm-id}&key=base64:{realm-key}
  gripUrl: process.env.GRIP_URL || configFromPulumi.gripUrl,
  name: configFromPulumi.name,
};

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
