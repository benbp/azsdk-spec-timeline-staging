#!/bin/bash
ORG="https://dev.azure.com/azure-sdk"
PRJ="project=internal"

# .NET builds (defId=5244)
az devops invoke --area build --resource builds --organization $ORG --route-parameters $PRJ --query-parameters "definitions=5244" "\$top=10" "queryOrder=finishTimeDescending" --output json | jq -c > builds-net-5244.json

# Python builds (defId=1027)
az devops invoke --area build --resource builds --organization $ORG --route-parameters $PRJ --query-parameters "definitions=1027" "\$top=10" "queryOrder=finishTimeDescending" --output json | jq -c > builds-python-1027.json

# JS builds (defId=4187)
az devops invoke --area build --resource builds --organization $ORG --route-parameters $PRJ --query-parameters "definitions=4187" "\$top=10" "queryOrder=finishTimeDescending" --output json | jq -c > builds-js-4187.json

# Java - search for correct resource manager pipeline
az devops invoke --area build --resource definitions --organization $ORG --route-parameters $PRJ --query-parameters "name=java - azure-resourcemanager-search" --output json | jq -c > java-search-def.json

# Go build timeline (release stage timing)
az devops invoke --area build --resource timeline --organization $ORG --route-parameters $PRJ buildId=6087243 --output json | jq -c > timeline-6087243.json

echo "Done! Files: builds-net-5244.json builds-python-1027.json builds-js-4187.json java-search-def.json timeline-6087243.json"


