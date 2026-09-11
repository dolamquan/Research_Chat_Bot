"""The always-present assistant: websocket transport around the agent runtime.

`protocol` defines the frames, `client_tools` lets the browser lend the model
UI actions, `confirmations` parks risky calls until the user says yes,
`speech` derives the short spoken line, and `connection` ties it together
per websocket.
"""
