#!/bin/bash
find src -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \) \
    -exec grep -rhoE 'ipcRenderer\.(invoke|send)' {} + \
    | wc -l
