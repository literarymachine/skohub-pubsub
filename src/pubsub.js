import express from 'express'
import request from 'superagent'
import crypto from 'crypto'
import parseLinkHeader from 'parse-link-header'
import WebSocket  from 'ws'

const DEFAULT_LEASE = 7
const LDP_INBOX = 'http://www.w3.org/ns/ldp#inbox'
const subscriptions = {}

const pubsub = express()

pubsub.use(express.json({ type: ['application/ld+json', 'application/json'] }))
pubsub.use(express.urlencoded({ extended: true }))

pubsub.get('/inbox', (req, res) => {
  if (!req.query.target) {
    return res.status(400).send()
  }
  res.status(200).send({
    '@context': 'http://www.w3.org/ns/ldp',
    '@id': `${req.protocol}://${req.get('host')}${req.url}`,
    'contains': []
  })
})

pubsub.post('/inbox', async (req, res) => {
  const target = req.query.target
  if (!target || req.headers['content-type'] !== 'application/ld+json') {
    return res.status(400).send()
  }
  try {
    const linkHeadersResponse = await request.get(target)
    const linkHeader = parseLinkHeader(linkHeadersResponse.headers.link)
    if (
      !linkHeader ||
      !linkHeader[LDP_INBOX] ||
      linkHeader[LDP_INBOX].url !== `http://localhost:3000/inbox?target=${target}`
    ) {
      throw new Error('Invalid target URL')
    }
  } catch (e) {
    return res.status(400).send()
  }
  res.status(202).send()
  Object.keys(subscriptions[target] || {}).forEach(callback => {
    request.post(callback).send(req.body).then(res => res, err => err)
  })
})

pubsub.post('/hub', async (req, res) => {
  if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') {
    return res.status(400).send()
  }

  const {
    'hub.callback': callback,
    'hub.mode': mode,
    'hub.topic': topic,
    'hub.lease_seconds': lease = DEFAULT_LEASE
  } = req.body

  if (!callback || !/subscribe|unsubscribe/.test(mode) || !topic) {
    return res.status(400).send()
  }

  try {
    const linkHeadersResponse = await request.get(topic)
    const linkHeader = parseLinkHeader(linkHeadersResponse.headers.link)
    if (
      !linkHeader ||
      !linkHeader.hub ||
      !linkHeader.self ||
      linkHeader.hub.url !== 'http://localhost:3000/hub' ||
      linkHeader.self.url !== topic
    ) {
      throw new Error('Invalid topic or hub URL')
    }
  } catch (e) {
    return res.status(400).send()
  }

  res.status(202).send()

  const challenge = crypto.randomBytes(64).toString('hex')

  try {
    const callbackResponse = await request.get(callback)
      .query(`hub.mode=${mode}`)
      .query(`hub.topic=${topic}`)
      .query(`hub.challenge=${challenge}`)
      .query(`hub.lease_seconds=${lease}`)

    if (callbackResponse.text !== challenge) {
      throw new Error('Invalid challenge in response')
    }

    if (mode === 'subscribe') {
      subscriptions[topic] = subscriptions[topic] || {}
      subscriptions[topic][callback] = lease
    } else {
      delete subscriptions[topic][callback]
    }
  } catch (e) {
    // discard subscription request
  }
})

const wss = new WebSocket.Server({ noServer: true })
wss.on('connection', ws => {
  ws.on('message', message => {
    console.log('ws message received', JSON.parse(message))
  })
  console.log('ws connected')
})

pubsub.wss = wss

export default pubsub
