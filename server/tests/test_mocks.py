from mocks import MockTools


def test_single_response_for_any_arguments():
    mocks = MockTools({"get_order": {"id": "A1"}})
    message = mocks.call("get_order", {"order_id": "anything"}, "c1")
    assert message.content == '{"id": "A1"}' and message.status == "success"
    assert mocks.unmocked == []


def test_cases_match_on_a_subset_of_arguments_first_match_wins():
    mocks = MockTools({"ship": {"cases": [{"when": {"n": "1"}, "response": "one"}, {"response": "other"}]}})
    assert mocks.call("ship", {"n": "1", "extra": True}, "c1").content == "one"
    assert mocks.call("ship", {"n": "2"}, "c2").content == "other"


def test_raise_fails_the_call_but_counts_as_mocked():
    mocks = MockTools({"refund": {"raise": "503"}})
    message = mocks.call("refund", {}, "c1")
    assert message.status == "error" and message.content == "503"
    assert mocks.unmocked == []


def test_unmocked_tool_and_unmatched_case_are_strict_failures():
    mocks = MockTools({"ship": {"cases": [{"when": {"n": "1"}, "response": "one"}]}})
    assert mocks.call("refund", {"id": "A1"}, "c1").status == "error"
    assert "not mocked" in mocks.call("ship", {"n": "9"}, "c2").content
    assert [call["name"] for call in mocks.unmocked] == ["refund", "ship"]


def test_sequence_answers_each_call_in_turn_then_repeats_the_last():
    mocks = MockTools({"generate": {"sequence": ["img-1", "img-2"]}})
    assert [mocks.call("generate", {}, f"c{i}").content for i in range(3)] == ["img-1", "img-2", "img-2"]


def test_sequence_counts_per_tool():
    mocks = MockTools({"a": {"sequence": ["a1", "a2"]}, "b": {"sequence": ["b1", "b2"]}})
    assert [mocks.call(n, {}, "c").content for n in ("a", "b", "a")] == ["a1", "b1", "a2"]


def test_when_any_value_matches_the_value_under_any_argument_name():
    # Parallel calls carry the record id as `post_id` on one run and `id` on the next, so match on the value.
    cases = [{"when_any_value": "P1", "response": {"raise": "400 published"}}, {"response": "saved"}]
    mocks = MockTools({"update_post": {"cases": cases}})
    assert mocks.call("update_post", {"post_id": "P1"}, "c1").status == "error"
    assert mocks.call("update_post", {"id": "P1", "caption": "x"}, "c2").status == "error"
    assert mocks.call("update_post", {"id": "P2"}, "c3").content == "saved"


def test_sequence_is_safe_under_parallel_tool_calls():
    from concurrent.futures import ThreadPoolExecutor

    mocks = MockTools({"gen": {"sequence": [f"img-{i}" for i in range(20)]}})
    with ThreadPoolExecutor(max_workers=20) as pool:
        replies = list(pool.map(lambda i: mocks.call("gen", {}, f"c{i}").content, range(20)))
    assert sorted(replies) == sorted(f"img-{i}" for i in range(20))


def test_empty_sequence_is_unmocked_not_a_crash():
    mocks = MockTools({"gen": {"sequence": []}})
    assert mocks.call("gen", {}, "c1").status == "error"
    assert mocks.unmocked == [{"name": "gen", "args": {}}]


def _write_then_read_mocks():
    return MockTools({
        "update_post": {"cases": [{"when": {"post_id": "P9"}, "response": {"raise": "404"}}, {"response": "saved"}]},
        "get_post": {"cases": [
            {"after": {"update_post": {"post_id": "P1"}}, "response": {"caption": "Hi"}},
            {"response": {"caption": "old text"}}]},
    })


def test_after_answers_a_read_differently_once_the_write_happened():
    mocks = _write_then_read_mocks()
    assert mocks.call("get_post", {"post_id": "P1"}, "c1").content == '{"caption": "old text"}'
    assert mocks.call("get_post", {"post_id": "P1"}, "c2").content == '{"caption": "old text"}'
    mocks.call("update_post", {"post_id": "P1", "caption": "Hi"}, "c3")
    assert mocks.call("get_post", {"post_id": "P1"}, "c4").content == '{"caption": "Hi"}'


def test_after_needs_the_listed_arguments_and_a_successful_call():
    mocks = _write_then_read_mocks()
    mocks.call("update_post", {"post_id": "P2"}, "c1")   # another post
    mocks.call("update_post", {"post_id": "P9"}, "c2")   # fails with 404
    assert mocks.call("get_post", {"post_id": "P1"}, "c3").content == '{"caption": "old text"}'


def test_after_with_empty_arguments_matches_any_call_to_that_tool():
    mocks = MockTools({"ship": "ok", "status": {"cases": [{"after": {"ship": {}}, "response": "shipped"}, {"response": "pending"}]}})
    assert mocks.call("status", {}, "c1").content == "pending"
    mocks.call("ship", {"order": "A1"}, "c2")
    assert mocks.call("status", {}, "c3").content == "shipped"

