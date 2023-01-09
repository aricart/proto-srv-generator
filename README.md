# proto-srv-generator

Generate NATS services from a protobuf description

This is a proof of concept - and currently only runs in nodejs. It generates a
NATS service based on a protobuf services definition.

## Setup a Project

```bash
mkdir services
cd services
curl -fSs https://raw.githubusercontent.com/ripienaar/nmfw/main/example/service.proto --output service.proto
deno run -A generator.ts --proto services.proto --out out
cd out
npm install 
# currently requires a not yet released version of nats, so this grabs it from my local system
npm install nats
npm link nats
npm run build
```

The library generates several files, and if your protobuf file contains multiple
services, it will generate one set of files per service.

```bash
tree
.
|-- calc_clients.ts
|-- calc_handlers.ts
|-- calc_service.ts
|-- package-lock.json
|-- package.json
|-- service.proto
|-- service.ts
`-- tsconfig.json

0 directories, 9 files
```

### Edit the Handlers

```typescript
// edit your services here
import {
  AddRequest,
  AverageRequest,
  CalcResponse,
  ExpressionRequest,
} from "./service.js";
export namespace Calc {
  export function AverageHandler(r: AverageRequest): Promise<CalcResponse> {
    // add your code here
    return Promise.reject(new Error("not implemented"));
  }

  export function AddHandler(r: AddRequest): Promise<CalcResponse> {
    // add your code here
    return Promise.reject(new Error("not implemented"));
  }

  export function ExpressionHandler(
    r: ExpressionRequest,
  ): Promise<CalcResponse> {
    // add your code here
    return Promise.reject(new Error("not implemented"));
  }
}
```

Change the file to do something with the input, and return the specified output:

```typescript
// edit your services here
import {
  AddRequest,
  AverageRequest,
  CalcResponse,
  ExpressionRequest,
} from "./service.js";
export namespace Calc {
  export function AverageHandler(r: AverageRequest): Promise<CalcResponse> {
    if (r.Values.length === 0) return Promise.reject(new Error("bad request"));
    const sum = r.Values.reduce((sum: number, v: number) => {
      return sum + v;
    });
    const Result = sum / r.Values.length;
    const Operation = "average";
    return Promise.resolve({ Result, Operation });
  }
  // ...
}
```

### Running the service

To run the service you'll need a local nats-server with no authentication:

```bash
npm run build
node calc_service.js
```

### Creating a client

The `calc_client.ts` is a generated class `CalcClient` that can invoke the
service using request reply using NATS. You'll need to write a little driver,
but the skeleton is already made.

Create the file `main.ts` and enter the following contents:

```typescript
import { CalcClient } from "./calc_client.js";
import { connect } from "nats";
// connect to NATS
const nc = await connect({ debug: true });
// create an instance of the CalcClient passing as argument the connection
const cc = new CalcClient(nc);
// invoke the various rpcs by giving an appropiate protobuf value as JSON
console.log(await cc.Add({ Values: [1, 2, 3] }));
console.log(await cc.Average({ Values: [1, 2, 3] }));
// close the connection when done
await nc.close();
```

To run it:

```bash
npm run build
node main.js
> INFO {"server_id":"NAK5Z4P7NFM5BKX2CVF3SRQ7PZ5OMBZLXPSQBFSQ4XCQLDVSROGHDEAI","server_name":"NAK5Z4P7NFM5BKX2CVF3SRQ7PZ5OMBZLXPSQBFSQ4XCQLDVSROGHDEAI","version":"2.9.10","proto":1,"go":"go1.19.4","host":"0.0.0.0","port":4222,"headers":true,"max_payload":1048576,"client_id":46,"client_ip":"127.0.0.1"} ␍␊
< CONNECT {"protocol":1,"version":"2.11.0-0","lang":"nats.js","verbose":false,"pedantic":false,"headers":true,"no_responders":true}␍␊
< PING␍␊
> PONG␍␊
< SUB _INBOX.1JIY0C1817HH3F5PADIRVO.* 1␍␊PUB Calc.Add _INBOX.1JIY0C1817HH3F5PADIRVO.1JIY0C1817HH3F5PADIRSY 14␍␊␊
                                                                                                                �?@@@␍␊
> MSG _INBOX.1JIY0C1817HH3F5PADIRVO.1JIY0C1817HH3F5PADIRSY 1 10␍␊␊add�@␍␊
{ Operation: 'add', Result: 6 }
< PUB Calc.Average _INBOX.1JIY0C1817HH3F5PADIRVO.1JIY0C1817HH3F5PADIRYE 14␍␊␊
                                                                             �?@@@␍␊
> MSG _INBOX.1JIY0C1817HH3F5PADIRVO.1JIY0C1817HH3F5PADIRYE 1 14␍␊␊average@␍␊
{ Operation: 'average', Result: 2 }
```

The lines prefixed by `>` and `<` are messages flowing through NATS, the JSON
`{ Operation: 'add', Result: 6 }` is the result of the `cc.Add()` operation
above.
