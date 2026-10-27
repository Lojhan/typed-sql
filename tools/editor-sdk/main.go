// The native TypeScript VS Code client accepts a custom SDK executable named tsc.
// Keep this launcher independent of TypeScript APIs and SQL grammar semantics.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
)

var typescriptVersion string

func main() {
	args := os.Args[1:]
	if len(args) == 1 && (args[0] == "--version" || args[0] == "-v") {
		fmt.Println("Version " + typescriptVersion)
		return
	}
	lsp := false
	for _, arg := range args {
		if arg == "--lsp" {
			lsp = true
		}
	}
	if !lsp {
		fmt.Fprintln(os.Stderr, "The typed-sql editor SDK requires --lsp. Use typed-sql check for compiler verification.")
		os.Exit(2)
	}
	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	server := filepath.Join(filepath.Dir(exe), "..", "..", "dist", "packages", "language-server", "src", "server.js")
	node := os.Getenv("TYPED_SQL_NODE")
	if node == "" {
		node = "node"
	}
	command := exec.Command(node, append([]string{server}, args...)...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	command.Env = append(os.Environ(), "TYPED_SQL_EDITOR_SDK=1")
	if err = command.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "Cannot start the typed-sql SDK. Install Node.js >=22.11 or set TYPED_SQL_NODE:", err)
		os.Exit(1)
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case received := <-signals:
				if command.Process.Signal(received) != nil {
					_ = command.Process.Kill()
				}
			case <-done:
				return
			}
		}
	}()
	err = command.Wait()
	signal.Stop(signals)
	close(done)
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok && exit.ExitCode() >= 0 {
			os.Exit(exit.ExitCode())
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
