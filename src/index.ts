import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as pulumi from "@pulumi/pulumi";
import FanoutGraphqlAwsApp from "./FanoutGraphqlAwsApp";

const pulumiConfig = new pulumi.Config("fanout.io-lambda-demo");

const configFromPulumi = {
  gripUrl: pulumiConfig.get("grip.uri"),
};

const config = {
  // like https://api.fanout.io/realm/{realm-id}?iss={realm-id}&key=base64:{realm-key}
  gripUrl: process.env.GRIP_URL || configFromPulumi.gripUrl,
};

const fanoutGraphqlAwsAppPulumiName = "demo";

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
