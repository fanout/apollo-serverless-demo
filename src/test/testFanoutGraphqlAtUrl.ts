import { basename } from "path";
import * as url from "url"
import { testFanoutGraphqlHttpAtUrl } from "../SubscriptionsTransportWebSocketOverHttp.test"

const timer = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Script to test a GraphQL Server at a given URL to make sure it adequately serves the FanoutGraphql app w/ subscriptions et al
 */
const main = async (urlArg: string) => {
  const parsedUrlArg = url.parse(urlArg)
  const httpUrl = url.format({ ...parsedUrlArg, protocol: 'http' })
  const subscriptionsUrl = `ws://${url.format({ ...parsedUrlArg, protocol: undefined })}`
  console.log('about to test for Fanout GraphQL', { httpUrl, subscriptionsUrl })
  await testFanoutGraphqlHttpAtUrl(urlArg, subscriptionsUrl, () => timer(5000))
}

if (require.main === module) {
  const urlArg = process.argv[2] || "http://localhost:7999"
  if ( ! urlArg) {
    console.info(`usage: ts-node ${basename(__filename)} {url}`)
    process.exit(1)
  }
  main(urlArg).catch((error) => {
    console.error(error);
    process.exit(1)
  })
}
