package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sync"
	"time"

	"github.com/jessevdk/go-flags"
)

type Options struct {
	Context        string   `short:"c" long:"context" description:"K8s context used to run script" required:"true"`
	Namespace      string   `short:"n" long:"namespace" description:"K8s namespace to commands in" required:"true"`
	Application    []string `short:"a" long:"application" description:"Application to migrate" required:"true"`
	Region         string   `short:"r" long:"region" description:"Region" required:"true"`
	RancherToken   string   `long:"rancher-token" description:"Rancher token" required:"true"`
	RancherContext string   `long:"rancher-context" description:"Rancher context" required:"true"`
	Force          bool     `short:"f" long:"force" description:"Ignores Argo CD Sync check"`
}

func runCommand(cmd string, args ...string) (string, string, error) {
	command := exec.Command(cmd, args...)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	outStr, errStr := string(stdout.Bytes()), string(stderr.Bytes())
	return outStr, errStr, err
}

func switchContext(context string) {
	_, _, err := runCommand("kubectl", "config", "use-context", context)
	if err != nil {
		fmt.Printf("\u2718 failed to switch k8s context: %s\n", err.Error())
		os.Exit(1)
	}
	fmt.Printf("\u2713 successfully switched context to %s\n", context)
}

func validateNamespace(namespace string) {
	_, _, err := runCommand("kubectl", "get", "namespace", namespace)
	if err != nil {
		fmt.Printf("\u2718 failed to access %s namespace: %s\n", namespace, err.Error())
		os.Exit(1)
	}
	fmt.Printf("\u2713 %s namespace exists\n", namespace)
}

func validateArgoCdAuth() {
	_, _, err := runCommand("argocd", "app", "list")
	if err != nil {
		fmt.Println("trying to log into Argo CD")
		_, _, err = runCommand("argocd", "login", "argocd.external.glops.io", "--sso", "--grpc-web-root-path", "/")
		time.Sleep(3 * time.Second)
		if err != nil {
			fmt.Printf("\u2718 failed to access argocd instance. please login using the command `argocd login argocd.external.glops.io --sso --grpc-web-root-path /`\n")
			os.Exit(1)
		}
	}
	fmt.Printf("\u2713 argocd authenticated\n")
}

// Example of healthy app:
// krona-reconciliation-qainternal-e1 qainternal krona-qainternal Synced Healthy Auto-Prune <none> https://greenlight.jfrog.io/artifactory/gl-helm 2.4.0-rc.1
func validateArgoCdApp(force bool, namespace string, application string, region string) {
	if !force {
		stdOut, _, err := runCommand("argocd", "app", "list", "-l", fmt.Sprintf("namespace=%s,application=%s,region=%s", namespace, application, region))
		if !regexp.MustCompile(fmt.Sprintf(`.*-%s-%s-%s.*Synced.*Healthy`, application, namespace, region)).MatchString(stdOut) {
			fmt.Printf("\u2718 %s application is not synced in %s environment\n", application, namespace)
			os.Exit(1)
		}
		if err != nil {
			fmt.Printf("\u2718 %s applications are not synced in argocd\n", application)
			os.Exit(1)
		}
		fmt.Printf("\u2713 %s applications synced in argocd\n", application)
	}
}

func validateRancherAuth(rancherToken string, rancherContext string) {
	_, _, err := runCommand("rancher", "login", "-t", rancherToken, "--context", rancherContext, "https://ops-rancher.greenlight.me/v3")
	if err != nil {
		fmt.Printf("\u2718 unable to authenticate with rancher: %s\n", err.Error())
		os.Exit(1)
	}
	fmt.Printf("\u2713 successfully authenticated with rancher\n")
}

func validateRancherApp(application string, namespace string) {
	stdOut, _, err := runCommand("rancher", "apps", "ls")
	if !regexp.MustCompile(fmt.Sprintf(`%s-%s[a-zA-Z0-9 ].*active`, application, namespace)).MatchString(stdOut) {
		fmt.Printf("\u2718 %s rancher application not in specified context\n", application)
		os.Exit(1)
	}
	if err != nil {
		fmt.Printf("\u2718 unable to list rancher apps: %s\n", err.Error())
		os.Exit(1)
	}
	fmt.Printf("\u2713 validated %s rancher application in specified context\n", application)
}

func validatePermissions(namespace string) {
	_, _, err := runCommand("kubectl", "auth", "can-i", "delete", "configmaps", "--namespace", namespace)
	if err != nil {
		fmt.Printf("\u2718 not authorized to delete configmaps in %s namespace: %s\n", namespace, err.Error())
		os.Exit(1)
	}
	fmt.Printf("\u2713 validated %s namespace permissions\n", namespace)
}

func deleteConfigMaps(namespace string, application string) {
	_, _, err := runCommand("kubectl", "delete", "configmaps", "-n", namespace, "-l", fmt.Sprintf("NAME=%s-%s", application, namespace))
	if err != nil {
		fmt.Printf("\u2718 failed to delete configmaps for %s in %s namespace: %s\n", application, namespace, err.Error())
		os.Exit(1)
	}
	fmt.Printf("\u2713 deleted configmaps for %s in %s namespace\n", application, namespace)
	time.Sleep(2 * time.Second)
}

func deleteRancherApp(application string, namespace string) {
	_, _, err := runCommand("rancher", "app", "delete", fmt.Sprintf("%s-%s", application, namespace))
	if err != nil {
		fmt.Printf("\u2718 failed to deleting rancher app %s-%s \n", application, namespace)
		os.Exit(1)
	}
	fmt.Printf("\u2713 successfully deleted rancher app %s-%s\n", application, namespace)
	time.Sleep(5 * time.Second)
}

func main() {
	opts := new(Options)
	_, err := flags.ParseArgs(opts, os.Args)
	if err != nil {
		return
	}

	if opts.Force {
		fmt.Print("Using -force can be dangerous, press enter to continue or ctrl + c to quit")
		var noop string
		_, _ = fmt.Scanln(&noop)
	}

	if opts.Region != "e1" && opts.Region != "e2" {
		fmt.Println("Invalid region. Must be one of (e1, e2)")
		os.Exit(1)
	}

	switchContext(opts.Context)
	validateNamespace(opts.Namespace)
	validateArgoCdAuth()
	validateRancherAuth(opts.RancherToken, opts.RancherContext)
	validatePermissions(opts.Namespace)

	var wg sync.WaitGroup

	for _, app := range opts.Application {
		wg.Add(1)

		go func(app string) {
			validateArgoCdApp(opts.Force, opts.Namespace, app, opts.Region)
			validateRancherApp(app, opts.Namespace)
			deleteConfigMaps(opts.Namespace, app)
			deleteRancherApp(app, opts.Namespace)
			validateArgoCdApp(false, opts.Namespace, app, opts.Region)

			wg.Done()
		}(app)
	}

	wg.Wait()
}
