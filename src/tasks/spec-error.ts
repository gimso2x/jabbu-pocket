export class TaskSpecError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TaskSpecError";
	}
}
