import { mergeRouters } from "../..";
import { createGreptileRouter } from "./greptile";
import { createSlotManagerRouter } from "./slot-manager";
import { createTestResultsRouter } from "./test-results";

export const createArchOneRouter = () => {
	return mergeRouters(
		createGreptileRouter(),
		createSlotManagerRouter(),
		createTestResultsRouter(),
	);
};
