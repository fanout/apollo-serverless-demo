import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import dedent from "ts-dedent";

let endpoint = new awsx.apigateway.API("example", {
	routes: [{
		path: "/",
		method: "GET",
		eventHandler: async (event) => {
			return {
				statusCode: 200,
				headers: {
					'content-type': 'text/html',
				},
				body: dedent`
					<!doctype html>
					<h1>fanout.io lambda demo</h1>
					<p>
						This is served by AWS Lambda.
					</p>
				`,
			};
		},
	}],
});

export const url = endpoint.url
