# CurseForge update checker (for McForge's updateJSONURL)

This project aims at making forge's `updateJSONURL` as easy as possible.

It is a web API that will return `updateJSONURL` compatible JSON files for your mod, using CurseForge as the source
to determine available versions.

All you need to do is specify the endpoint in your `updateJSONURL`, like this:

```toml
# ...
displayName="Magic Feather"

# 284745 is the modId, you can find it on your CurseForge page.
updateJSONURL="https://mc-curse-update-checker.herokuapp.com/284745"
# ...
```

*This project is MIT, feel free to self-host your own version!*
