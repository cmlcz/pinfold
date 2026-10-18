# Every Tool is a Write Tool until the developer classifies it as a Read Tool

Plan's safety guarantee rests entirely on accurate Read/Write classification: a Write Tool misclassified as a Read Tool would execute live during a Plan. Under the MCP specification, tool annotations (`readOnlyHint` and related fields) are untrusted hints unless provided by an explicitly trusted server. The Gateway therefore treats every Tool as a Write Tool by default, uses server annotations only to pre-fill a suggestion, and stores the developer's explicit classification in local configuration.

