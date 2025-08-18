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

	context.subscriptions.push(vscode.commands.registerCommand('deep-code-reviewer.setOpenAIKey', async () => {
		const key = await vscode.window.showInputBox({
			prompt: 'Enter your OpenAI API key',
			password: true
		});
		if (!key) {return;}
		await context.secrets.store('deepCode.openai.apiKey', key);
		vscode.window.showInformationMessage('OpenAI API key saved securely.');
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
