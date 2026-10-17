"""Creates the tests dataset with a few starter tests for the demo agent, and publishes the agent's tool names.

The tool names go on the dataset's metadata (`agent_tools`), which is where the editor reads them from in both
modes: a custom app inside LangSmith can't reach this server, but it can read the dataset.

    uv run python seed.py      # also runs on server start; never overwrites existing tests
"""

from __future__ import annotations

from dotenv import load_dotenv
from langsmith import Client

load_dotenv()

from harness import DATASET_NAME  # noqa: E402
from agent_hook import load_hook  # noqa: E402

TOOL_NAMES = load_hook().TOOL_NAMES

_A1001 = {"id": "A1001", "status": "delivered", "total": 42.5, "items": ["Trail mug"], "delivered_on": "2026-10-01",
          "tracking": None}


def _test(name, description, prompt, mocks, assertions, recorded_on="2026-10-03"):
    return {
        "inputs": {"prompt": prompt, "mock_tools": mocks, "recorded_on": recorded_on},
        "outputs": {"assertions": [{"name": k, "assertion": v} for k, v in assertions]},
        "metadata": {"name": name, "description": description, "dataset_split": ["base"]},
    }


TESTS = [
    _test("refund-damaged-item", "A small order arrived broken: refund it in full.",
          "Hi, order A1001 arrived and the mug was shattered. Can I get my money back?",
          {"get_order": _A1001,
           "issue_refund": {"refund_id": "RF-77310", "order_id": "A1001", "amount": 42.5, "status": "issued"}},
          [("refunds-full-amount", "It issues a refund for order A1001 of exactly $42.50."),
           ("shares-refund-id", "Its reply gives the customer the refund ID RF-77310.")]),
    _test("refund-service-down", "The refund call fails: the agent must not claim it worked.",
          "Order A1001 showed up broken. Please refund it.",
          {"get_order": _A1001, "issue_refund": {"raise": "503 Service Unavailable: payments backend timed out"}},
          [("admits-failure", "It tells the customer the refund could not be processed right now."),
           ("no-false-claim", "It never says or implies that the refund was issued.")]),
    _test("large-refund-escalates", "Over the $200 limit: hand off to a human instead of refunding.",
          "My tent from order A1003 arrived with a torn rainfly. I want a full refund.",
          {"get_order": {"id": "A1003", "status": "delivered", "total": 649.0, "items": ["4-person tent"],
                         "delivered_on": "2026-10-02", "tracking": None}},
          [("no-refund-call", "It does not call issue_refund."),
           ("escalates", "It says a teammate will follow up within one business day.")]),
    _test("where-is-my-order", "In transit: give the carrier's estimated delivery date.",
          "Where is my order A1002?",
          {"get_order": {"id": "A1002", "status": "shipped", "total": 129.0, "items": ["Down vest"],
                         "tracking": "1Z999AA10123456784"},
           "get_shipping_status": {"cases": [
               {"when": {"tracking_number": "1Z999AA10123456784"},
                "response": {"tracking_number": "1Z999AA10123456784", "carrier": "UPS", "status": "in_transit",
                             "estimated_delivery": "2026-10-06", "last_scan": "Memphis, TN"}}]}},
          [("right-eta", "It gives the estimated delivery date that get_shipping_status returned."),
           ("names-carrier", "It says the package is with UPS.")]),
]


def ensure_dataset(client: Client | None = None):
    """Creates the dataset and its starter tests if it doesn't exist; refreshes `agent_tools` either way."""
    client = client or Client()
    if client.has_dataset(dataset_name=DATASET_NAME):
        dataset = client.read_dataset(dataset_name=DATASET_NAME)
    else:
        dataset = client.create_dataset(DATASET_NAME, description="Given / When / Then tests for the agent, edited "
                                        "with the eval editor.")
        client.create_examples(dataset_id=dataset.id, examples=TESTS)
    if (dataset.metadata or {}).get("agent_tools") != TOOL_NAMES:
        client.request_with_retries("PATCH", f"/datasets/{dataset.id}",
                                    json={"metadata": {**(dataset.metadata or {}), "agent_tools": TOOL_NAMES}})
    return dataset


if __name__ == "__main__":
    dataset = ensure_dataset()
    print(f"{DATASET_NAME}: {dataset.url}")
