"""A small customer-support agent to demo the eval editor on.

It looks up orders and shipments and issues refunds. The tools read a tiny in-memory store, so the agent runs
without any external systems; tests never touch it, because every tool call in a test is answered by a mock.

Try it (traces land in the LANGSMITH_PROJECT project, which the editor's Import button reads):

    uv run python demo_agent.py "Order A1001 arrived broken, can I get my money back?"
"""

from __future__ import annotations

import os
import sys
from datetime import date, timedelta

from langchain.agents import create_agent
from langchain_core.tools import tool

MODEL = os.environ.get("AGENT_MODEL", "anthropic:claude-haiku-5-5")

INSTRUCTIONS = """You are the support agent for Northwind Outfitters, an online outdoor-gear shop.

- Look orders up before answering anything about them; never guess order details.
- Refunds: you may refund a delivered order that arrived damaged or wrong, up to $200 per order, for no more
  than the order total. Larger refunds go to a human: say a teammate will follow up within one business day,
  and do not call issue_refund.
- When a refund goes through, give the customer the refund ID. If it fails, say so plainly and do not claim
  the refund was issued.
- For "where is my order", check the shipment and give the estimated delivery date.
- Be brief and friendly."""

_TODAY = date.today()
_ORDERS = {
    "A1001": {"id": "A1001", "status": "delivered", "total": 42.50, "items": ["Trail mug"],
              "delivered_on": str(_TODAY - timedelta(days=2)), "tracking": None},
    "A1002": {"id": "A1002", "status": "shipped", "total": 129.00, "items": ["Down vest"],
              "tracking": "1Z999AA10123456784"},
    "A1003": {"id": "A1003", "status": "delivered", "total": 649.00, "items": ["4-person tent"],
              "delivered_on": str(_TODAY - timedelta(days=1)), "tracking": None},
}


@tool
def get_order(order_id: str) -> dict:
    """Look up an order by its ID (like A1001): status, total, items and tracking number."""
    order = _ORDERS.get(order_id.upper())
    if not order:
        raise ValueError(f"No order {order_id}")
    return order


@tool
def get_shipping_status(tracking_number: str) -> dict:
    """Current carrier status and estimated delivery date for a tracking number."""
    return {"tracking_number": tracking_number, "carrier": "UPS", "status": "in_transit",
            "estimated_delivery": str(_TODAY + timedelta(days=3)), "last_scan": "Memphis, TN"}


@tool
def issue_refund(order_id: str, amount: float, reason: str) -> dict:
    """Refund part or all of an order to the customer's original payment method."""
    return {"refund_id": f"RF-{order_id}-{int(amount * 100)}", "order_id": order_id, "amount": amount,
            "status": "issued"}


TOOLS = [get_order, get_shipping_status, issue_refund]


def build_agent(middleware=()):
    return create_agent(MODEL, tools=TOOLS, system_prompt=INSTRUCTIONS, middleware=list(middleware))


if __name__ == "__main__":
    from dotenv import load_dotenv

    load_dotenv()
    os.environ.setdefault("LANGSMITH_TRACING", "true")
    os.environ.setdefault("LANGSMITH_PROJECT", "eval-editor-demo-agent")
    prompt = " ".join(sys.argv[1:]) or "Order A1001 arrived broken, can I get my money back?"
    result = build_agent().invoke({"messages": [{"role": "user", "content": prompt}]})
    print(result["messages"][-1].text)
