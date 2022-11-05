Writing fungit plugins
=====================

It's super easy to write an fungit plugin. Here's how to write a completely new (though super simple) git log ui:

### 1. Create a new folder for your plugin.
Create a folder at `~/.fungit/plugins/MY_FANCY_PLUGIN`, then add a file called `fungit-plugin.json` with the following content:
```JSON
{
  "exports": {
    "javascript": "example.js"
  }
}
```

### 2. Add some code
Create an `example.js` file and add this:

```JavaScript
var components = require('fungit-components');

// We're overriding the graph component here
components.register('graph', function(args) {
  return {
    // This method creates and returns the DOM node that represents this component.
    updateNode: function() {
      var node = document.createElement('div');
      // Request all log entries from the backend
      args.server.get('/log', { path: args.repoPath, limit: 50 }, function(err, log) {
        // Add all log entries to the parent node
        log.forEach(function(entry) {
          var entryNode = document.createElement('div');
          entryNode.innerHTML = entry.message;
          node.appendChild(entryNode);
        });
      });
      return node;
    }
  };
});
```

### 3. Done!
Just restart fungit, or if you have `"dev": true` in your `.fungitrc` you can just refresh your browser.  A [gerrit plugin example](https://github.com/ungtb10d/fungit-gerrit) can be found here.

### fungit Plugin API version
The fungit Plugin API follows semver, and the current version can be found in the package.json (fungitPluginApiVersion). On the frontend it can be accessed from `fungit.pluginApiVersion` and on the backend `env.pluginApiVersion`.

### Components

Each functionalities within fungit is built as components.  Each components is an fungit plugin that is checked into main repository.  All the components in fungit is built as plugins, take a look in the [components](https://github.com/ungtb10d/fungit/tree/master/components) directory for inspiration.

An [example](https://github.com/ungtb10d/fungit/tree/master/components/staging) of fungit component with view can be seen below.

```JSON
{
  "exports": {
    "knockoutTemplates": {
      "staging": "staging.html"
    },
    "javascript": "staging.bundle.js",
    "css": "staging.css"
  }
}
```

* Views(html) for Component

   Each component can have multiple views as exampled [here](https://github.com/ungtb10d/fungit/tree/master/components/dialogs).

* CSS for Component
   css file can be easily defined per components and in above example we can see that `staging.less` file is compiled into `staging.css` via `npm run build` script.

* JS for Component

   Each component gets to have one javascipt files.  However each javasciprt file can require other javascript in it's directory or other libraries.  If you are doing require by relative paths as exampled in [graph.js](https://github.com/ungtb10d/fungit/blob/master/components/graph/graph.js), you wouldn't have to include the js in browserify job in [`scripts/build.js`](https://github.com/ungtb10d/fungit/blob/master/scripts/build.js).
