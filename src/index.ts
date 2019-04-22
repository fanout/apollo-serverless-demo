import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as pulumi from "@pulumi/pulumi";
import FanoutGraphqlAwsApp from "./FanoutGraphqlAwsApp";

const name = "demo";

const endpoint = new awsx.apigateway.API(`${name}-api-gateway`, {
  routes: FanoutGraphqlAwsApp(`${name}-lambda`).routes,
});

/** URL of FanoutGraphglAwsApp API Gateway */
export const url = endpoint.url;
