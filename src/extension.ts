// run in terminal to push latest changes to github

// git add .
// git commit -m "Describe what you changed"
// or
// git commit -m "Updated extension.ts"
// git push origin main



// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import OpenAI from 'openai';
import { userInfo } from 'os';
import { json } from 'stream/consumers';
import { assertToolCallsAreChatCompletionFunctionToolCalls } from 'openai/lib/parser.mjs';

type ReviewIssue = {
  line: number; // remember number is 1-based
  severity: 'error' | 'warning' | 'info';
  message: string;
  suggestion?: string; // ? to make it optional 
};

let diagCollection: vscode.DiagnosticCollection; // this is how vs code shows errors and squiggly lines


// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	const diagCollection = vscode.languages.createDiagnosticCollection('deep-code-review'); // creates a collection for all the review problems
	context.subscriptions.push(diagCollection); // this line makes vs code clean it up when reloading/unloading

	// This is the first command, here the user will set the API key

	// The line below registers a command in the palette (opened by ctrl/command + shift + p)
	context.subscriptions.push(vscode.commands.registerCommand('deep-code-reviewer.setOpenAIKey', async () => {
		const key = await vscode.window.showInputBox({
			prompt: 'Enter your OpenAI API key',
			password: true
		});
		if (!key) {return;}
		await context.secrets.store('deepCode.openai.apiKey', key);
		vscode.window.showInformationMessage('OpenAI API key saved securely.');
	}));

	// This is the second command, here the user will review their code (particularly the code in the current tab they opened)
	// Perhaps we can add functionality to allow only selected text to be reviewed
	context.subscriptions.push(vscode.commands.registerCommand('deep-code-reviewer.reviewCode', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage('No active editor!');
			return;
		}

		const apiKey = await context.secrets.get('deepCode.openai.apiKey');
		if (!apiKey) {
    		vscode.window.showErrorMessage('Please set your OpenAI API key first.');
    		return;
		}

		const code = editor.document.getText();

		vscode.window.showInformationMessage("Reviewing code with AI..");

		const client = new OpenAI({apiKey});

		const res = await client.chat.completions.create({
			model : "gpt-5-nano",
			messages: [
				{
					role: "system",
					content: "You are a code reviewer. Respond with JSON array of issues: [{line, severity, message, suggestion}]"

				},
				{
					role: "user",
					content: "code"
				}
			],
			response_format: {type: "json_object"}
		});

		const output = res.choices[0].message?.content;

		// here we parse our issues (revieved in JSON format) 

		let issues: ReviewIssue[] = [];
		try {
			issues = JSON.parse(output || "[]");
		} catch (err) 
			{vscode.window.showErrorMessage("failed to parse GPT response" + output);
			return;
		}

		diagCollection.clear(); // this clears the old squiggly lines

		// now its time to actually make our issues reflect on to vs code 

		const diagnostics: vscode.Diagnostic[] = [];


		for (const issue of issues) { // for...of gives the object for...in gives the index
			const lineIndex = issue.line - 1; // issue is an object with line as an attribute 
			if (lineIndex < 0 || lineIndex >= editor.document.lineCount) {
				continue;
			}

			const range = new vscode.Range(
				lineIndex, 0, // first line index 0 
				lineIndex, editor.document.lineAt(lineIndex).text.length // to last line index "the lines length"
			);

			const diagnostic = new vscode.Diagnostic(
				range, 
				issue.message,
				issue.severity === "error"
				? vscode.DiagnosticSeverity.Error
				: issue.severity === "warning"
				? vscode.DiagnosticSeverity.Warning
				: vscode.DiagnosticSeverity.Information
			);

			if (issue.suggestion) {
				diagnostic.code = issue.suggestion;
			}

			diagnostics.push(diagnostic);

			diagCollection.set(editor.document.uri, diagnostics)
		}
	
	}));	
	
	// some notes for the code above 
	// async allows us to use await
	// we use await becase a user takes time to enter a password

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "deep-code-reviewer" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('deep-code-reviewer.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from deep-code-reviewer!');
	});

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}
